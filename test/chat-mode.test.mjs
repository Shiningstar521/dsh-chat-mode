/**
 * Offline harness for dsh-chat-mode's Host half.
 *
 * The real Harness is a live Electron app, so this script drives the plugin's
 * `apply()` against a minimal fake context that mirrors the contracts the plugin
 * uses (session projection fold, command lifecycle, agent lifecycle, working
 * directory, attachments). It verifies behavior, not styling.
 *
 * Run: npm test   (or: node test/chat-mode.test.mjs)
 */
import os from 'node:os'
import path from 'node:path'
import { apply, chatModeProjection } from '../index.js'

let failures = 0
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`ok   ${name}`)
  } else {
    failures += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const WORKSPACE = path.join(os.tmpdir(), 'chat-mode-workspace')

/** A fake Session whose log is the projection input. */
function makeSession(header = {}) {
  return {
    header: { origin: undefined, ...header },
    events: [],
    append(type, data) {
      this.events.push({ type, data })
      return { type, data }
    },
  }
}

/** The projection handle the framework would hand back. */
const handle = {
  stateOf(session) {
    let state = chatModeProjection.init()
    for (const event of session.events) state = chatModeProjection.apply(state, event)
    chatModeProjection.stateSchema.parse(state)
    chatModeProjection.wire.viewSchema.parse(chatModeProjection.wire.view(state))
    return state
  },
  view(session) {
    return chatModeProjection.wire.view(this.stateOf(session))
  },
}

/** A fake Agent exposing the scope surface the plugin touches. */
function makeAgent(session) {
  const agent = {
    session,
    restrictions: [],
    sections: [],
    suppressed: false,
    ctx: {
      tools: {
        restrict(filter) {
          agent.restrictions.push(filter)
          return () => {
            const index = agent.restrictions.indexOf(filter)
            if (index >= 0) agent.restrictions.splice(index, 1)
          }
        },
      },
      systemPrompt: {
        section(section) {
          agent.sections.push(section)
          return () => {
            const index = agent.sections.indexOf(section)
            if (index >= 0) agent.sections.splice(index, 1)
          }
        },
        suppressRuntimeContext() {
          agent.suppressed = true
          return () => {
            agent.suppressed = false
          }
        },
        getSectionOrder() {
          return 0
        },
      },
    },
  }
  return agent
}

/** Build the fake plugin context plus its inspection surface. */
function makeContext(options = {}) {
  const listeners = new Map()
  const commands = new Map()
  const state = { workspaceCreates: [], directorySets: [], ensured: 0, pickerCalls: 0 }

  const ctx = {
    logger: { warn: (...args) => console.log('warn', ...args) },
    sessionProjections: {
      register(definition) {
        if (definition !== chatModeProjection) throw new Error('unexpected projection definition')
        return Promise.resolve(handle)
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    get(name) {
      if (name === 'attachments') return options.attachments
      if (name === 'workspaceController') {
        return {
          async create(request) {
            state.workspaceCreates.push(request.path)
            return { created: true }
          },
        }
      }
      if (name === 'directoryPickerController') {
        state.pickerCalls += 1
        return {
          async pick() {
            state.pickerCalls += 1
            return options.pickedDirectory ?? null
          },
        }
      }
      return undefined
    },
    workingDirectory: {
      async set(agent, target) {
        if (options.noDirectory) throw new Error('no directory')
        const directory = path.isAbsolute(target) ? target : path.resolve(WORKSPACE, target)
        state.directorySets.push(directory)
        agent.session.append('working-directory/change', { cwd: directory })
        return directory
      },
      async ensure(agent) {
        if (options.noDirectory) throw new Error('no directory')
        state.ensured += 1
        return agent.session.cwd ?? WORKSPACE
      },
      get(session) {
        if (options.noDirectory) throw new Error('no directory')
        return session.cwd ?? WORKSPACE
      },
    },
  }

  const emit = async (event, payload) => {
    for (const listener of listeners.get(event) ?? []) {
      await listener(payload, async () => ({ kind: 'accept', messages: [] }))
    }
  }

  const run = async (agent, name, rawInput = '') => {
    const definition = commands.get(name)
    if (definition === undefined) throw new Error(`unknown command ${name}`)
    const commandId = `cmd-test-${agent.session.events.length}`
    agent.session.append('command/run', { commandId, name, source: { kind: 'user' } })
    let result
    try {
      result = await definition.handler({
        agent,
        rawInput,
        attachments: [],
        signal: new AbortController().signal,
        commandId,
      })
    } catch (error) {
      agent.session.append('command/done', { commandId, kind: 'error', text: String(error) })
      throw error
    }
    agent.session.append('command/done', {
      commandId,
      kind: result.kind,
      ...(result.text === undefined ? {} : { text: result.text }),
    })
    return result
  }

  const preStep = async (agent, messages = []) => {
    const payload = { agent, messages, turn: 1, step: 1, signal: new AbortController().signal, modelSelection: {} }
    const next = async () => ({ kind: 'accept', messages })
    let result = { kind: 'accept', messages }
    for (const listener of listeners.get('agent/pre-step') ?? []) result = await listener(payload, next)
    return result
  }

  return { ctx, emit, run, preStep, state }
}

/** Boot one plugin instance over a fresh conversation. */
async function boot(options = {}) {
  const made = makeContext(options)
  apply(made.ctx)
  const session = makeSession({ cwd: options.cwd ?? WORKSPACE })
  const agent = makeAgent(session)
  await made.emit('agent/created', { agent })
  return { ...made, session, agent }
}

// ── 1. A blank conversation starts in chat mode ─────────────────────────────
{
  const { session, agent } = await boot()
  check('blank conversation materializes chat mode', session.events.length === 2, JSON.stringify(session.events))
  check('materialized event is a chat command', session.events[0]?.data?.name === 'chat')
  check('projection reports chat mode', handle.view(session).mode === 'chat')
  check('chat mode hides every tool', agent.restrictions.length === 1 && agent.restrictions[0].allow.length === 0)
  check(
    'chat mode replaces the persona',
    agent.sections.some((section) => section.complete === true && section.name === 'deployment:persona-prefix'),
  )
  const persona = agent.sections.find((section) => section.name === 'deployment:persona-prefix')
  const personaText = persona !== undefined && typeof persona.text === 'function' ? persona.text() : ''
  check('chat persona disclaims historical tool records', personaText.includes('history only') && personaText.includes('no tools'), personaText.slice(0, 80))
  check('chat mode drops runtime context', agent.suppressed === true)
}

// ── 2. A conversation that already has messages keeps work mode ─────────────
{
  const made = makeContext()
  apply(made.ctx)
  const session = makeSession({ cwd: WORKSPACE })
  session.append('user/message', { role: 'user', content: [], source: { kind: 'user' } })
  const agent = makeAgent(session)
  await made.emit('agent/created', { agent })
  check('used conversation falls back to work mode', handle.view(session).mode === 'work')
  check('used conversation keeps its tools', agent.restrictions.length === 0)
}

// ── 3. /chat switches a work conversation ──────────────────────────────────
{
  const made = makeContext()
  apply(made.ctx)
  const session = makeSession({ cwd: WORKSPACE })
  session.append('user/message', { role: 'user', content: [], source: { kind: 'user' } })
  const agent = makeAgent(session)
  await made.emit('agent/created', { agent })
  check('used conversation starts in work', handle.view(session).mode === 'work')
  const result = await made.run(agent, 'chat')
  check('/chat succeeds', result.kind === 'success', JSON.stringify(result))
  check('/chat records chat mode', handle.view(session).mode === 'chat')
  await made.preStep(agent)
  check('chat mode applies at the next step', agent.restrictions.length === 1)
}

// ── 4. /work reuses the workspace and never prompts ────────────────────────
{
  const { run, agent, state, preStep } = await boot()
  check('starts in chat', handle.view(agent.session).mode === 'chat')
  const result = await run(agent, 'work')
  check('/work succeeds', result.kind === 'success', JSON.stringify(result))
  check('/work never opens a directory picker', state.pickerCalls === 0, String(state.pickerCalls))
  check('/work does not move the directory', state.directorySets.length === 0, JSON.stringify(state.directorySets))
  check('/work reuses the current workspace', state.ensured === 1 && result.text.includes(WORKSPACE), result.text)
  check('/work switches the conversation', handle.view(agent.session).mode === 'work')
  await preStep(agent)
  check('/work restores the tools at the next step', agent.restrictions.length === 0)
  check('/work restores the persona at the next step', agent.sections.length === 0)
}

// ── 5. Chat ⇄ work ⇄ work never asks again ─────────────────────────────────
{
  const { run, agent, state, preStep } = await boot()
  await run(agent, 'work')
  await run(agent, 'chat')
  const again = await run(agent, 'work')
  check('second /work also succeeds', again.kind === 'success', JSON.stringify(again))
  check('no prompt across repeated switches', state.pickerCalls === 0, String(state.pickerCalls))
  check('no directory change across repeated switches', state.directorySets.length === 0, JSON.stringify(state.directorySets))
  check('same workspace reported twice', again.text.includes(WORKSPACE), again.text)
  await preStep(agent)
  check('tools follow the last switch', agent.restrictions.length === 0)
}

// ── 6. An explicit path still moves the conversation ───────────────────────
{
  const target = path.join(os.tmpdir(), 'chat-mode-other')
  const { run, agent, state } = await boot()
  const result = await run(agent, 'work', `  ${target}  `)
  check('explicit path switches immediately', result.kind === 'success' && result.text.includes(target), JSON.stringify(result))
  check('explicit path becomes the working directory', state.directorySets[0] === target, JSON.stringify(state.directorySets))
  check('explicit path is registered as a project', state.workspaceCreates[0] === target, JSON.stringify(state.workspaceCreates))
}

// ── 7. A conversation with no directory reports instead of prompting ───────
{
  const { run, agent } = await boot({ noDirectory: true })
  const result = await run(agent, 'work')
  check('missing directory reports an error', result.kind === 'error', JSON.stringify(result))
  check('missing directory keeps chat mode', handle.view(agent.session).mode === 'chat')
}

// ── 8. Uploaded documents are inlined for a chat-mode step ─────────────────
{
  const encoder = new TextEncoder()
  const attachments = {
    async *readFileStream(ref) {
      yield encoder.encode(ref.name === 'notes.txt' ? 'hello from the upload' : '\u0000\u0001binary')
    },
  }
  const { session, agent, preStep } = await boot({ attachments })
  void session
  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: 'summarize this' },
      { type: 'file', attachment: { attachmentId: 'attachment:abc', name: 'notes.txt', bytes: 21 } },
      { type: 'file', attachment: { attachmentId: 'attachment:def', name: 'blob.bin', bytes: 8 } },
    ],
  }]
  const decision = await preStep(agent, messages)
  const content = decision.messages[0].content
  check('text upload is inlined', content[1].type === 'text' && content[1].text.includes('hello from the upload'), JSON.stringify(content[1]))
  check('binary upload keeps its handle', content[2].type === 'file')
  check('original user text is preserved', content[0].text === 'summarize this')
}

// ── 9. Work mode leaves messages untouched ─────────────────────────────────
{
  const made = makeContext()
  apply(made.ctx)
  const session = makeSession({ cwd: WORKSPACE })
  session.append('user/message', { role: 'user', content: [], source: { kind: 'user' } })
  const agent = makeAgent(session)
  await made.emit('agent/created', { agent })
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const decision = await made.preStep(agent, messages)
  check('work mode passes messages through', decision.messages === messages)
}

// ── 10. Subagent sessions are never materialized ───────────────────────────
{
  const made = makeContext()
  apply(made.ctx)
  const session = makeSession({ origin: 'subagent', cwd: WORKSPACE })
  const agent = makeAgent(session)
  await made.emit('agent/created', { agent })
  check('subagent sessions stay untouched', session.events.length === 0)
  check('subagent sessions keep their tools', agent.restrictions.length === 0)
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
