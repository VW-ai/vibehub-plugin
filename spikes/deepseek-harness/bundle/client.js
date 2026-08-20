/**
 * Disposable browser-plane proof that VibeHub can live inside the official
 * DeepSeek Harness Web client without replacing its native Chat surface.
 *
 * This file intentionally follows DSH's tiny browser module protocol directly.
 * A production package will be authored in TSX and compiled by the upstream
 * client bundler after the product surface is approved.
 */

window.__ModuleLoader__.load({
  id: 'dsh-vibehub-foundation-spike',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const { jsx, jsxs } = require('react/jsx-runtime')
    const { useEffect, useState } = require('react')

    const css = `
      .vh-action,.vh-context,.vh-start{font:inherit;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);border-radius:7px;cursor:pointer}
      .vh-action{border:0;padding:2px 6px;font-size:12px}.vh-action:hover,.vh-context:hover,.vh-start:hover{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent)}
      .vh-context{height:26px;padding:0 8px;font-size:12px;white-space:nowrap}.vh-context[data-on=true]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
      .vh-view{box-sizing:border-box;width:min(920px,100%);margin:0 auto;padding:22px 24px 140px;color:var(--dsw-alias-label-primary)}
      .vh-kicker{margin:0 0 6px;color:var(--dsw-alias-state-business-primary);font-size:11px;font-weight:650;letter-spacing:.08em;text-transform:uppercase}.vh-view h2{margin:0 0 5px;font-size:22px}.vh-muted{margin:0 0 20px;color:var(--dsw-alias-label-tertiary);font-size:13px}
      .vh-graph{display:grid;grid-template-columns:1fr 42px 1fr;gap:12px;align-items:center}.vh-node{padding:14px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 24%,transparent);border-radius:12px;background:var(--dsw-alias-bg-module-platform)}.vh-node strong{display:block;margin-bottom:4px;font-size:13px}.vh-node span{color:var(--dsw-alias-label-tertiary);font-size:12px}.vh-node[data-active=true]{border-color:var(--dsw-alias-state-business-primary)}.vh-edge{text-align:center;color:var(--dsw-alias-label-tertiary)}
      .vh-branch-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}.vh-branch{padding:12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 78%,transparent);font-size:12px}.vh-branch b{display:block;margin-bottom:4px}.vh-actions{display:flex;gap:8px;margin-top:16px}.vh-start{padding:7px 11px}.vh-start[data-primary=true]{color:white;background:var(--dsw-alias-state-business-primary);border-color:transparent}
      .vh-run-list{display:grid;gap:9px}.vh-step{display:grid;grid-template-columns:10px 1fr auto;gap:10px;align-items:center;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);font-size:13px}.vh-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.vh-step[data-state=running] .vh-dot{background:#ef9f27;box-shadow:0 0 0 4px color-mix(in srgb,#ef9f27 18%,transparent)}.vh-step[data-state=done] .vh-dot{background:#38a169}.vh-step small{color:var(--dsw-alias-label-tertiary)}
      .vh-overlay{pointer-events:auto;position:fixed;right:18px;bottom:18px;z-index:20;width:286px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary) 28%,transparent);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 94%,transparent);box-shadow:0 10px 34px rgba(0,0,0,.18);color:var(--dsw-alias-label-primary);backdrop-filter:blur(18px)}.vh-overlay[hidden]{display:none}.vh-overlay-head{display:flex;justify-content:space-between;gap:12px;font-size:12px;font-weight:650}.vh-overlay p{margin:7px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}.vh-overlay button{margin-top:9px}.vh-running{color:#ef9f27}
      @media(max-width:640px){.vh-view{padding:16px 14px 120px}.vh-graph{grid-template-columns:1fr}.vh-edge{transform:rotate(90deg)}.vh-branch-row{grid-template-columns:1fr}.vh-overlay{left:12px;right:12px;bottom:12px;width:auto}}
    `
    const styleId = 'dsh-vibehub-foundation-spike/client.css'
    if (!document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-vibehub-foundation-spike'
      style.dataset.pluginCss = styleId
      style.textContent = css
      document.head.appendChild(style)
    }

    function emitRun(state) {
      document.dispatchEvent(new CustomEvent('vibehub:run-state', { detail: state }))
    }

    function ContextControl() {
      const [enabled, setEnabled] = useState(true)
      return jsx('button', {
        type: 'button',
        className: 'vh-context',
        'data-on': enabled,
        title: 'Controls whether the next model turn may load VibeHub Context',
        onClick: () => setEnabled(value => !value),
        children: enabled ? 'Context on' : 'Context off',
      })
    }

    function GraphView({ sessionId }) {
      return jsxs('section', { className: 'vh-view', 'data-vibehub-view': 'graph', children: [
        jsx('p', { className: 'vh-kicker', children: 'VibeHub · Thought graph' }),
        jsx('h2', { children: 'Explore without losing the main line' }),
        jsx('p', { className: 'vh-muted', children: `Native DSH session ${String(sessionId).slice(0, 8)} · explicit forks, no inferred knowledge graph` }),
        jsxs('div', { className: 'vh-graph', children: [
          jsxs('div', { className: 'vh-node', children: [jsx('strong', { children: 'Shape the task harness' }), jsx('span', { children: 'Main conversation · current context' })] }),
          jsx('div', { className: 'vh-edge', children: '→' }),
          jsxs('div', { className: 'vh-node', 'data-active': true, children: [jsx('strong', { children: 'Bring back the useful result' }), jsx('span', { children: 'Compare two branches, then converge' })] }),
        ] }),
        jsxs('div', { className: 'vh-branch-row', children: [
          jsxs('div', { className: 'vh-branch', children: [jsx('b', { children: 'Branch A · Ticket interaction' }), 'Drag, search, craft and start a Ticket.'] }),
          jsxs('div', { className: 'vh-branch', children: [jsx('b', { children: 'Branch B · Context protocol' }), 'Turn project Context on only when the human asks.'] }),
        ] }),
        jsxs('div', { className: 'vh-actions', children: [
          jsx('button', { type: 'button', className: 'vh-start', children: 'Compare branches' }),
          jsx('button', { type: 'button', className: 'vh-start', 'data-primary': true, children: 'Bring back' }),
        ] }),
      ] })
    }

    function RunView({ sessionId }) {
      const [running, setRunning] = useState(false)
      const start = () => {
        setRunning(true)
        emitRun({ sessionId, ticket: 'VH-001', phase: 'Implementing client slots' })
      }
      return jsxs('section', { className: 'vh-view', 'data-vibehub-view': 'run', children: [
        jsx('p', { className: 'vh-kicker', children: 'VibeHub · Execution' }),
        jsx('h2', { children: 'Ticket VH-001' }),
        jsx('p', { className: 'vh-muted', children: 'The execution surface remains visible while native Chat stays available.' }),
        jsxs('div', { className: 'vh-run-list', children: [
          jsxs('div', { className: 'vh-step', 'data-state': 'done', children: [jsx('i', { className: 'vh-dot' }), jsx('span', { children: 'Context assembled from checked-in Ticket references' }), jsx('small', { children: 'evidence' })] }),
          jsxs('div', { className: 'vh-step', 'data-state': running ? 'running' : 'queued', children: [jsx('i', { className: 'vh-dot' }), jsx('span', { children: 'Implement client slot integration' }), jsx('small', { children: running ? 'running' : 'queued' })] }),
          jsxs('div', { className: 'vh-step', children: [jsx('i', { className: 'vh-dot' }), jsx('span', { children: 'Human acceptance' }), jsx('small', { children: 'waiting' })] }),
        ] }),
        jsx('div', { className: 'vh-actions', children: jsx('button', { type: 'button', className: 'vh-start', 'data-primary': true, onClick: start, children: running ? 'Running…' : 'Start Ticket' }) }),
      ] })
    }

    function ExecutionOverlay({ bootstrap }) {
      const [run, setRun] = useState(null)
      const [opening, setOpening] = useState(false)
      useEffect(() => {
        const listener = event => setRun(event.detail)
        document.addEventListener('vibehub:run-state', listener)
        return () => document.removeEventListener('vibehub:run-state', listener)
      }, [])
      const openDemo = async () => {
        setOpening(true)
        try { await bootstrap() } finally { setOpening(false) }
      }
      return jsxs('aside', { className: 'vh-overlay', 'data-vibehub-overlay': true, children: [
        jsxs('div', { className: 'vh-overlay-head', children: [
          jsx('span', { children: run === null ? 'VibeHub · DSH Client Spike' : 'VH-001 · Execution' }),
          jsx('span', { className: run === null ? '' : 'vh-running', children: run === null ? 'Native slot' : '● Running' }),
        ] }),
        jsx('p', { children: run === null ? 'Open a disposable Session to inspect Graph, Run and Context inside native Chat.' : run.phase }),
        run === null ? jsx('button', { type: 'button', className: 'vh-start', 'data-primary': true, disabled: opening, onClick: openDemo, children: opening ? 'Opening…' : 'Open demo Session' }) : null,
      ] })
    }

    const inject = ['slots', 'sessions', 'workspaces']
    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'vibehub-context', order: 40,
      }, ContextControl))

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions', id: 'vibehub-fork', order: 20,
      }, function ForkAction({ sessionId }) {
        const [state, setState] = useState('Fork')
        const fork = async () => {
          setState('Forking…')
          try {
            const childId = await ctx.sessions.fork({ sessionId, increaseTitle: true })
            ctx.sessions.open(childId)
          } catch {
            setState('Retry fork')
          }
        }
        return jsx('button', { type: 'button', className: 'vh-action', onClick: fork, children: state })
      }))

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'vibehub-graph', order: 30, label: () => 'Graph',
      }, GraphView))
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'vibehub-run', order: 40, label: () => 'Run',
      }, RunView))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'vibehub-execution', order: 30,
        inject: () => ({ bootstrap: async () => {
          const workspace = await ctx.workspaces.create({ path: '/Users/bytedance/personal/vibehub-plugin' })
          const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId)
          ctx.sessions.open(sessionId)
        } }),
      }, ExecutionOverlay))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
