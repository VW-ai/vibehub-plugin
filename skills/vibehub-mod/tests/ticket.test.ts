import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ROOT = '/repo'
const VH = '/home/me/.claude/skills/vibehub-core/scripts/vh.mjs'
const SURFACES = ['terminal', 'desktop'] as const
const ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: true, columns: 160 }

const ROOM = 'kind: decision\nsummary: Mods carry the active Ticket.\n'
const TICKET = {
  ticket_id: 'ticket-mod',
  title: 'Mod 交互探索',
  outcome: 'Ship the VibeHub mod.',
  status: 'in_progress',
  context: 'Start from the Mod API survey.',
  constraints: ['Support terminal and desktop.'],
  acceptance: [{ criterion: 'Typeahead lists Tickets.', state: 'active' }],
  relations: [{ type: 'depends_on', target_ticket_id: 'ticket-title' }],
  context_refs: [
    { ref: '.vibehub/rooms/product/decision-mod.yaml', purpose: 'the decision' },
    { ref: 'skills/vibehub-core/scripts/vh.mjs', purpose: 'the helper' },
  ],
  updates: [{ summary: 'Surveyed the API.', status: 'in_progress', recorded_at: '2026-10-07T10:00:00Z' }],
}
const entry = (ticket: Record<string, unknown>, state: string) => ({ ticket, ticket_state: { state } })
const GRAPH = {
  tickets: [
    entry(TICKET, 'IN_PROGRESS'),
    entry({ ticket_id: 'ticket-title', title: 'Ticket 短标题', outcome: 'Tickets carry a short title.' }, 'OPEN'),
    entry({ ticket_id: 'ticket-cli', outcome: 'Decide whether VibeHub ships a standalone CLI.' }, 'OPEN'),
    entry({ ticket_id: 'ticket-later', outcome: 'Later.' }, 'BLOCKED'),
    entry({ ticket_id: 'ticket-base', title: 'Base work', outcome: 'Done before.' }, 'DONE'),
  ],
  relations: [
    { prerequisite_ticket_id: 'ticket-title', dependent_ticket_id: 'ticket-mod' },
    { prerequisite_ticket_id: 'ticket-base', dependent_ticket_id: 'ticket-mod' },
    { prerequisite_ticket_id: 'ticket-mod', dependent_ticket_id: 'ticket-later' },
  ],
}

const world = (on: On, options: { vibehub?: boolean; pane?: boolean } = {}) => {
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/.vibehub` ? options.vibehub !== false : e.path === VH }))
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const [, , domain, op] = e.argv
    const input = e.init?.stdin ? JSON.parse(e.init.stdin) : {}
    const data =
      domain === 'ticket' && op === 'graph' ? GRAPH
      : domain === 'ticket' && op === 'get' ? { ticket: TICKET }
      : domain === 'context' && input.ref === TICKET.context_refs[0]!.ref ? { source: ROOM }
      : { source: 'x'.repeat(10) }

    return { value: { exitCode: 0, stdout: JSON.stringify({ ok: true, data }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const submitted: { text: string; context: readonly string[] }[] = []
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, context: e.context ?? [] })

    return { text: e.text, context: e.context }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' as const }] }))
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  const fills: string[] = []
  on('prompt.fill', ($, e) => {
    fills.push(e.text)

    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('ui.open', () => {
    if (options.pane === false) throw new Error('no surface seats a pane')

    return { value: undefined } as never
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(JSON.stringify(e))

    return { value: undefined } as never
  })

  return { calls, submitted, fills, toasts }
}

const typed = (text: string) => {
  const token = text.split(/\s/).at(-1)!

  return { text, cursor: text.length, token, start: text.length - token.length }
}

type Suggestion = { text: string; label?: string; description?: string }
// The kit raises prompt.autocomplete at run time; its Engine typing omits it.
type Completer = { autocomplete: (e: ReturnType<typeof typed>) => Promise<{ suggestions: Suggestion[] }> }

test('# typeahead lists Tickets by title, state, and id', async ($, on) => {
  world(on)
  const prompt = $.prompt as unknown as Completer
  await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  const all = await prompt.autocomplete(typed('看一下 #'))
  expect(all.suggestions.map(s => s.text)).toEqual(['#ticket-mod', '#ticket-title', '#ticket-cli', '#ticket-later'])
  const some = await prompt.autocomplete(typed('看一下 #标题'))
  expect(some.suggestions).toEqual([{ text: '#ticket-title', label: 'Ticket 短标题', description: 'Ready · #ticket-title' }])
  const untitled = await prompt.autocomplete(typed('#cli'))
  expect(untitled.suggestions[0]?.label).toBe('Decide whether VibeHub ships a standalone CLI.')
})

test('a #mention carries the brief once, then a short reminder', async ($, on) => {
  const { submitted, toasts } = world(on)
  await $.prompt.submit({ text: '#ticket-mod 继续做面板', origin: ORIGIN, wait: false })
  const first = submitted.at(-1)!
  expect(first.text).toBe('#ticket-mod 继续做面板')
  expect(first.context).toHaveLength(1)
  expect(first.context[0]).toContain('# VibeHub Ticket #ticket-mod: Mod 交互探索')
  expect(first.context[0]).toContain('Mods carry the active Ticket.')
  expect(first.context[0]).toContain('- skills/vibehub-core/scripts/vh.mjs — the helper')
  expect(first.context[0]).not.toContain('xxxxxxxxxx')
  expect(toasts.at(-1)).toContain('Mod 交互探索')

  await $.prompt.submit({ text: '再看 #ticket-mod 和 #nope', origin: ORIGIN, wait: false })
  const second = submitted.at(-1)!
  expect(second.context).toHaveLength(1)
  expect(second.context[0]).toContain('Its full record is earlier in this session')

  await $.prompt.submit({ text: '没有引用 issue#12', origin: ORIGIN, wait: false })
  expect(submitted.at(-1)!.context).toHaveLength(0)

  const composed = await $.prompt.compose({
    model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [],
  })
  expect(composed.sections.at(-1)?.text).toContain('#ticket-mod: Mod 交互探索')
})

const pane = { title: 'VibeHub', isFocused: true, bodyColumns: 40, placement: 'dock' } as never

test('the pane opens on the graph and selects a Ticket from it, on terminal and desktop', async ($, on) => {
  const { calls, fills } = world(on)
  await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'vibehub-mod', surface, component: 'Pane', requestId: 'vibehub', props: pane })
    expect(await ui.find({ key: 'n:ticket-mod' })).toBeDefined()
    expect(await ui.find({ key: 'n:ticket-later' })).toBeDefined()
    expect(await ui.find({ key: 'n:ticket-base' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /standalone/ }))?.text).toBe('1 standalone Tickets are in List')
    if (surface === 'desktop') {
      const svg = await ui.find({ type: 'Svg' })
      expect(String(svg?.props.source)).toContain('#ticket-later · blocked')
      expect(String(svg?.props.alt)).toContain('4 Tickets, 3 dependencies')
    } else {
      expect((await ui.find({ key: 'n:ticket-title' }))?.text).toBe('○ Ticket 短标题')
      expect(await ui.find({ type: 'Text', text: 'Base work' })).toBeDefined()
      expect(await ui.findAll({ type: 'Text', text: '└─▶ ' })).toHaveLength(2)
    }
    const reads = calls.length
    await ui.press({ key: 'n:ticket-mod' })
    expect(calls.length).toBe(reads)
    const markdown = await ui.find({ type: 'Markdown' })
    expect(markdown?.text).toContain('**Constraints 1**')
    expect(markdown?.text).toContain('- Ticket 短标题')
    expect(markdown?.text).toContain('**Unblocks 1**\n- Later')
    await ui.press({ key: 'mention' })
    expect(fills.at(-1)).toBe('#ticket-mod ')
  }
})

test('the list view groups unfinished Tickets', async ($, on) => {
  world(on)
  await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'vibehub-mod', surface, component: 'Pane', requestId: 'vibehub', props: pane })
    await ui.press({ key: 'v:list' })
    expect((await ui.find({ key: 'g:in_progress' }))?.text).toBe('In progress 1')
    await ui.press({ key: 'g:open' })
    expect(await ui.find({ key: 't:ticket-title' })).toBeDefined()
    await ui.press({ key: 'v:graph' })
  }
})

test('/vh lists Tickets as text where no pane can open', async ($, on) => {
  world(on, { pane: false })
  const ran = await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  expect(ran.text).toContain('VibeHub: 4 unfinished Tickets.')
  expect(ran.text).toContain('In progress 1\n- #ticket-mod  Mod 交互探索')
  expect(ran.text).toContain('Blocked 1\n- #ticket-later  Later.')
})

test('a project without VibeHub says so and attaches nothing', async ($, on) => {
  const { calls, submitted } = world(on, { vibehub: false })
  const ran = await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  expect(ran.text).toContain('VibeHub is not set up')
  await $.prompt.submit({ text: '#ticket-mod hi', origin: ORIGIN, wait: false })
  expect(submitted.at(-1)!.context).toHaveLength(0)
  expect(calls).toHaveLength(0)
})
