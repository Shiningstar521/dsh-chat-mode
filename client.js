/**
 * dsh-chat-mode — browser half.
 *
 * Renders one compact 聊天 / 工作 segmented control in the composer tool row.
 * The control reads the host-computed `chatMode` Session projection (mode,
 * pending, project) and drives the mode through the logged `/chat` and `/work`
 * commands, so every tab and every reload shows the same durable state.
 *
 * The browser module is loaded lazily by the Harness module table; `require`
 * provides the shared React instance. No other Harness Client package is
 * imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'chat-mode'

    const zh = {
      label: '对话模式',
      chat: '聊天',
      work: '工作',
      chatTitle: '聊天模式：只对话，模型不能操作电脑（新建对话默认就是聊天模式）',
      workTitle: '工作模式：可以使用工具操作电脑，工作目录沿用当前工作区',
      failed: '切换模式失败',
      unknown: '无法识别的命令结果',
    }

    const en = {
      label: 'Conversation mode',
      chat: 'Chat',
      work: 'Work',
      chatTitle: 'Chat mode: conversation only — the model cannot operate your computer. New conversations start in chat mode.',
      workTitle: 'Work mode: the model can use tools on your computer, in this conversation’s current workspace.',
      failed: 'Could not switch mode',
      unknown: 'Unrecognized command result',
    }

    const css = [
      '.dshcm-wrap{display:inline-flex;align-items:center;gap:6px}',
      '.dshcm-track{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;',
      'background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
      '.dshcm-seg{height:24px;min-width:44px;padding:0 10px;border:none;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:24px;cursor:pointer;',
      'font-family:inherit;transition:background-color .12s ease,color .12s ease}',
      '.dshcm-seg:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.dshcm-seg:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshcm-seg[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'box-shadow:0 1px 2px rgba(0,0,0,.14)}',
      '.dshcm-seg:disabled{cursor:default;opacity:.65}',
      '.dshcm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:220px;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    /** Read the outcome of one executed command through the Remote envelope. */
    function outcomeOf(result, t) {
      if (result === undefined || result === null) throw new Error(t('unknown'))
      if (result.ok !== true) {
        const error = result.error
        throw new Error(error !== undefined && error !== null && error.message ? error.message : t('failed'))
      }
      const value = result.value
      if (value === undefined || value === null) throw new Error(t('unknown'))
      return value.result === undefined ? value : value.result
    }

    /**
     * Build the control bound to this browser plugin's context.
     * @param {{remote: {commands: {execute: Function}}}} ctx client plugin context.
     * @param {Function} boundT translate function for this plugin's namespace.
     * @returns {Function} the slot component.
     */
    function createControl(ctx, boundT) {
      return function ChatModeControl(props) {
        const t = props.t || boundT
        const view = props.useProjection('chatMode')
        const [busy, setBusy] = React.useState(null)
        const [error, setError] = React.useState(null)
        const alive = React.useRef(true)

        React.useEffect(() => () => {
          alive.current = false
        }, [])

        if (view === undefined || view === null) return null

        const mode = view.mode === 'chat' ? 'chat' : 'work'
        const disabled = busy !== null || view.pending === true

        const run = (key) => {
          if (disabled) return
          setBusy(key)
          setError(null)
          const line = key === 'chat' ? '/chat' : '/work'
          ctx.remote.commands.execute(props.sessionId, line, []).then(
            (result) => {
              if (!alive.current) return
              setBusy(null)
              try {
                const outcome = outcomeOf(result, t)
                if (outcome !== null && outcome !== undefined && outcome.kind === 'error') {
                  setError(outcome.text || t('failed'))
                }
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure))
              }
            },
            (failure) => {
              if (!alive.current) return
              setBusy(null)
              setError(failure instanceof Error ? failure.message : String(failure))
            },
          )
        }

        const segment = (key, label) => h('button', {
          type: 'button',
          className: 'dshcm-seg',
          'aria-pressed': mode === key ? 'true' : 'false',
          title: key === 'chat' ? t('chatTitle') : t('workTitle'),
          disabled,
          onClick: mode === key ? undefined : () => run(key),
        }, label)

        return h('span', { className: 'dshcm-wrap', role: 'group', 'aria-label': t('label') },
          h('style', { key: 'css' }, css),
          h('span', { className: 'dshcm-track', key: 'track' },
            segment('chat', t('chat')),
            segment('work', t('work')),
          ),
          error !== null
            ? h('span', { className: 'dshcm-error', role: 'status', title: error, key: 'error' }, error)
            : null,
        )
      }
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chat-mode: dictionaries')
        const Control = createControl(ctx, ctx.locale.bind(NS))
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'chat-mode',
          order: 10,
          locale: NS,
        }, Control))
      },
    }
  },
})
