/**
 * dsh-chat-mode — a chat / work mode switch for DeepSeek Harness.
 *
 * Chat mode is a pure conversation: the agent keeps the normal conversation UI
 * (composer, uploads, image attachments, history) but every tool is hidden from
 * its scope and its system prompt is replaced by a web-chat persona. Work mode
 * is the ordinary Harness agent. Switching never asks for a directory: the
 * conversation keeps the workspace it already belongs to, and only an explicit
 * `/work <directory>` moves it somewhere else.
 *
 * State is durable per Session:
 * - the mode is folded from the logged `/chat` and `/work` command events, so
 *   resume, fork and every browser tab agree without a plugin-owned mirror;
 * - a blank conversation records the default chat mode once, at its first Agent
 *   creation; a conversation that already holds messages is never rewritten.
 *
 * @module dsh-chat-mode
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const name = 'chat-mode'

/** Services this plugin cannot work without (an absent one keeps the row inactive). */
export const inject = ['sessionProjections', 'tools', 'systemPrompt', 'commands', 'agents', 'workingDirectory']

const CHAT = 'chat'
const WORK = 'work'
const CMD_CHAT = 'chat'
const CMD_WORK = 'work'
const DEFINITION_ID = 'dsh-chat-mode'

/**
 * The shared persona-prefix section name. Registering this same name from the
 * Agent's own scope shadows the deployment persona for that Agent only.
 */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'

/** Largest attachment inlined into a chat-mode prompt, in bytes / characters. */
const MAX_INLINE_BYTES = 400_000
const MAX_INLINE_CHARS = 100_000

/**
 * New conversations start in chat mode. The mode of a conversation that
 * already holds messages is never rewritten; see `agent/created` below.
 */
const DEFAULT_MODE = CHAT

/** One view object per projected state, so unchanged state publishes nothing. */
const viewCache = new WeakMap()

/** Fold of the logged mode commands; the Session log is the single source of truth. */
export const chatModeProjection = {
  key: 'chatMode',
  stateVersion: 1,
  stateSchema: z
    .object({
      mode: z.enum([CHAT, WORK]),
      explicit: z.boolean(),
      used: z.boolean(),
      project: z.string().nullable(),
      running: z.object({ commandId: z.string(), mode: z.enum([CHAT, WORK]) }).strict().nullable(),
    })
    .strict(),
  init: () => ({ mode: CHAT, explicit: false, used: false, project: null, running: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'user/message':
        return state.used ? state : { ...state, used: true }
      case 'working-directory/change':
        return state.project === event.data.cwd ? state : { ...state, project: event.data.cwd }
      case 'command/run': {
        if (event.data.name !== CMD_CHAT && event.data.name !== CMD_WORK) return state
        return {
          ...state,
          running: { commandId: event.data.commandId, mode: event.data.name === CMD_CHAT ? CHAT : WORK },
        }
      }
      case 'command/done': {
        const running = state.running
        if (running === null || running.commandId !== event.data.commandId) return state
        const committed = event.data.kind === 'success'
        return {
          ...state,
          mode: committed ? running.mode : state.mode,
          explicit: state.explicit || committed,
          running: null,
        }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: z.object({
      mode: z.enum([CHAT, WORK]),
      pending: z.boolean(),
      project: z.string().nullable(),
    }),
    view: (state) => {
      const cached = viewCache.get(state)
      if (cached !== undefined) return cached
      const view = {
        mode: state.running === null ? state.mode : state.running.mode,
        pending: state.running !== null,
        project: state.project,
      }
      viewCache.set(state, view)
      return view
    },
  },
}

/** Format one local calendar date as YYYY-MM-DD. */
function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * The complete chat-mode system prompt: a web-chat assistant with no computer.
 * `complete: true` makes this the whole system prompt while chat mode is active.
 */
function chatPersona() {
  return [
    'You are DeepSeek, a helpful and knowledgeable AI assistant. This conversation is in chat mode:',
    'talk with the user the way a web chat assistant does, and answer directly.',
    'You have no access to the user\'s computer — no file system, no terminal, no tools — so never claim to',
    'read, write, run, or inspect anything on their machine, and never offer to do so.',
    'Earlier turns of this conversation may contain tool calls and tool results from when it was in work',
    'mode: treat those as history only. Those tools do not exist now, so never try to call one, never say you',
    'just did, and never rely on a tool result being fresh.',
    'When the user attaches a file to a message, its text content is included in the message itself and',
    'images are visible to you; use that content directly. For anything that needs local files or programs,',
    'explain that the user can switch this conversation to work mode with the 聊天 / 工作 control in the',
    'composer.',
    'Reply in the language the user writes in.',
    `Today is ${localDate()}.`,
  ].join(' ')
}

/** Render a human-readable message for any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Install chat-mode enforcement on one live Agent: hide every inherited tool,
 * replace the persona, and drop the optional runtime context. Returns the
 * disposer that restores the agent.
 */
function installChatMode(agent, warn) {
  const disposers = []
  try {
    disposers.push(agent.ctx.tools.restrict({ allow: [] }))
  } catch (error) {
    warn('hide tools', error)
  }
  try {
    disposers.push(
      agent.ctx.systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
        text: chatPersona,
        complete: true,
      }),
    )
  } catch (error) {
    warn('replace persona', error)
  }
  try {
    disposers.push(agent.ctx.systemPrompt.suppressRuntimeContext())
  } catch (error) {
    warn('suppress runtime context', error)
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        // The owning agent scope may already be gone; nothing left to restore.
      }
    }
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 */
export function apply(ctx) {
  const projection = ctx.sessionProjections.register(chatModeProjection)
  /** Session -> disposer restoring work-mode behavior for that Agent. */
  const enforced = new Map()

  const warn = (what, error) => {
    try {
      ctx.logger?.warn(`chat-mode: cannot ${what}: %s`, messageOf(error))
    } catch {
      // Logging must never break a turn.
    }
  }

  /**
   * Record the mode a conversation starts with. Reusing the logged command
   * vocabulary keeps the projection fold and every client in agreement without
   * introducing a Session event type this build does not know.
   */
  const materialize = (session, mode) => {
    const commandId = `cmd-chat-mode-${randomUUID()}`
    session.append('command/run', {
      commandId,
      name: mode === CHAT ? CMD_CHAT : CMD_WORK,
      source: { kind: 'user' },
    })
    session.append('command/done', {
      commandId,
      kind: 'success',
      text: mode === CHAT ? '聊天模式' : '工作模式',
    })
  }

  const stateOf = async (session) => (await projection).stateOf(session)

  /**
   * Make the Agent's enforcement match its recorded mode. Idempotent: called at
   * Agent creation, once per step boundary, and therefore also after a mode
   * command committed from another tab.
   */
  const sync = async (agent) => {
    let state
    try {
      state = await stateOf(agent.session)
    } catch {
      return
    }
    const restore = enforced.get(agent.session)
    if (state.mode === CHAT) {
      if (restore === undefined) enforced.set(agent.session, installChatMode(agent, warn))
      return
    }
    if (restore !== undefined) {
      restore()
      enforced.delete(agent.session)
    }
  }

  const readAttachmentText = async (attachments, ref, signal) => {
    try {
      const chunks = []
      let bytes = 0
      for await (const chunk of attachments.readFileStream(ref, signal)) {
        bytes += chunk.length
        chunks.push(Buffer.from(chunk))
        if (bytes >= MAX_INLINE_BYTES) break
      }
      if (bytes === 0) return ''
      const buffer = Buffer.concat(chunks)
      if (buffer.includes(0)) return undefined // binary: leave the handle text in place
      const text = buffer.subarray(0, MAX_INLINE_BYTES).toString('utf8')
      return text.length > MAX_INLINE_CHARS ? `${text.slice(0, MAX_INLINE_CHARS)}\n…[truncated]` : text
    } catch {
      return undefined
    }
  }

  /**
   * Chat mode has no file tools, so an uploaded document's text is inlined into
   * the step's messages instead. Images stay image blocks (vision input), and
   * binary files keep the adapter's read-only handle text.
   */
  const inlineUploads = async (messages, signal) => {
    if (!messages.some((message) => message.role === 'user' && message.content.some((block) => block.type === 'file'))) {
      return messages
    }
    const attachments = ctx.get('attachments')
    if (attachments === undefined) return messages
    let changed = false
    const next = []
    for (const message of messages) {
      if (message.role !== 'user' || !message.content.some((block) => block.type === 'file')) {
        next.push(message)
        continue
      }
      const content = []
      let messageChanged = false
      for (const block of message.content) {
        if (block.type !== 'file') {
          content.push(block)
          continue
        }
        const text = await readAttachmentText(attachments, block.attachment, signal)
        if (text === undefined) {
          content.push(block)
          continue
        }
        const { name, bytes } = block.attachment
        content.push({
          type: 'text',
          text: `[Uploaded file "${name}" (${bytes} bytes)]\n${text}\n[/Uploaded file "${name}"]`,
        })
        messageChanged = true
      }
      if (!messageChanged) {
        next.push(message)
        continue
      }
      changed = true
      next.push({ ...message, content })
    }
    return changed ? next : messages
  }

  ctx.effect(() => () => {
    for (const restore of enforced.values()) {
      try {
        restore()
      } catch {
        // Agent scopes unwind on their own.
      }
    }
    enforced.clear()
  }, 'chat-mode: release per-agent enforcement')

  ctx.on('agent/created', async ({ agent }) => {
    try {
      if (agent.session.header.origin === 'subagent') return
      let state = await stateOf(agent.session)
      if (!state.explicit) {
        // A blank conversation takes the default; one that already holds
        // messages keeps working as before instead of losing its tools.
        const mode = state.used ? WORK : DEFAULT_MODE
        materialize(agent.session, mode)
        state = await stateOf(agent.session)
      }
      await sync(agent)
    } catch (error) {
      // A failing serial listener would fail the Agent creation itself.
      warn('initialize the conversation mode', error)
    }
  })

  ctx.on('agent/disposed', ({ agent }) => {
    const restore = enforced.get(agent.session)
    if (restore === undefined) return
    restore()
    enforced.delete(agent.session)
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      await sync(payload.agent)
      const state = await stateOf(payload.agent.session)
      if (state.mode !== CHAT) return decision
      const messages = await inlineUploads(decision.messages, payload.signal)
      return messages === decision.messages ? decision : { ...decision, messages }
    } catch (error) {
      // Never fail a turn because the mode projection or an upload read failed.
      warn('apply chat mode to this step', error)
      return decision
    }
  })

  ctx.commands.register({
    definitionId: DEFINITION_ID,
    name: CMD_CHAT,
    description: '切换到聊天模式：只对话，不使用任何工具',
    handler: async ({ agent }) => {
      if ((await stateOf(agent.session)).mode === CHAT) {
        return { kind: 'success', text: '已经是聊天模式：这个对话只用于对话，不会操作电脑。' }
      }
      return {
        kind: 'success',
        text: '已切换到聊天模式：这个对话只用于对话，不会操作电脑。',
      }
    },
  })

  ctx.commands.register({
    definitionId: DEFINITION_ID,
    name: CMD_WORK,
    description: '切换到工作模式；默认沿用当前工作区（/work [目录] 可换目录）',
    input: { hint: '[directory]' },
    handler: async ({ agent, rawInput, signal }) => {
      const session = agent.session
      const requested = rawInput.trim()
      let directory

      if (requested !== '') {
        // An explicit `/work <directory>` is the only path that moves the
        // conversation; switching modes otherwise never asks for anything.
        try {
          directory = await ctx.workingDirectory.set(agent, requested, signal)
        } catch (error) {
          return { kind: 'error', text: `无法使用该目录：${messageOf(error)}` }
        }
        const workspaces = ctx.get('workspaceController')
        if (workspaces !== undefined) {
          try {
            await workspaces.create({ path: directory })
          } catch (error) {
            warn('register the project directory', error)
          }
        }
      } else {
        // Keep the workspace this conversation already belongs to. No picker,
        // no new directory: chat ⇄ work must stay one click each way.
        try {
          directory = await ctx.workingDirectory.ensure(agent, signal)
        } catch (error) {
          warn('reuse the conversation directory', error)
        }
        if (directory === undefined) {
          try {
            directory = ctx.workingDirectory.get(session)
          } catch {
            directory = undefined
          }
        }
        if (directory === undefined) {
          return { kind: 'error', text: '这个对话还没有工作目录；请用 /work <目录> 指定一个。' }
        }
      }

      return { kind: 'success', text: `已切换到工作模式，工作目录：${directory}` }
    },
  })
}
