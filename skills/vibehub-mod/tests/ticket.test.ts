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

const world = (on: On, options: { vibehub?: boolean; pane?: boolean; graph?: unknown } = {}) => {
  mock.env(on, { HOME: '/home/me' })
  on('session.root', () => ({ value: ROOT }))
  on('fs.exists', ($, e) => ({ value: e.path === `${ROOT}/.vibehub` ? options.vibehub !== false : e.path === VH }))
  const calls: string[][] = []
  on('process.run', ($, e) => {
    calls.push([...e.argv])
    const [, , domain, op] = e.argv
    const input = e.init?.stdin ? JSON.parse(e.init.stdin) : {}
    const data =
      domain === 'ticket' && op === 'graph' ? options.graph ?? GRAPH
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
  expect(some.suggestions).toEqual([{ text: '#ticket-title', label: 'Ticket 短标题', description: 'Open · #ticket-title' }])
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

test('the pane lists Tickets in dependency lanes with dashboard states, on terminal and desktop', async ($, on) => {
  const { calls, fills } = world(on)
  await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: 'vibehub-mod', surface, component: 'Pane', requestId: 'vibehub', props: pane })
    expect((await ui.find({ key: 'f:all' }))?.text).toBe('All 4')
    const order = (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(key => key?.startsWith('n:'))
    expect(order).toEqual(['n:ticket-title', 'n:ticket-mod', 'n:ticket-later', 'n:ticket-cli'])
    expect(await ui.find({ key: 'n:ticket-base' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'unblocks Mod 交互探索' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'waiting on Ticket 短标题 · unblocks Later · built on 1 finished' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▶' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⊘' })).toBeDefined()

    await ui.press({ key: 'finished' })
    expect(await ui.find({ key: 'n:ticket-base' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '╯' })).toBeDefined()
    await ui.press({ key: 'finished' })

    const reads = calls.length
    await ui.press({ key: 'n:ticket-mod' })
    expect(calls.length).toBe(reads)
    const markdown = await ui.find({ type: 'Markdown' })
    expect(markdown?.text).toContain('**Constraints 1**')
    expect(markdown?.text).toContain('**Unblocks 1**\n- Later')
    await ui.press({ key: 'mention' })
    expect(fills.at(-1)).toBe('#ticket-mod ')
    await ui.press({ key: 'close' })
    expect(await ui.find({ type: 'Markdown' })).toBeUndefined()

    await ui.press({ key: 'f:blocked' })
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('n:')).map(b => b.key)).toEqual(['n:ticket-later'])
    await ui.press({ key: 'f:all' })
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

// A dense repository: each Ticket depends on up to three of the thirty before
// it, and most of them are finished.
const stressGraph = (count: number) => {
  let seed = 7
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const tickets: unknown[] = []
  const relations: { prerequisite_ticket_id: string; dependent_ticket_id: string }[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `ticket-stress-${index}`
    const roll = random()
    tickets.push(entry({ ticket_id: id, title: `Stress task ${index} with a realistic title`, outcome: `Outcome ${index}.` },
      roll < 0.6 ? 'DONE' : roll < 0.9 ? 'OPEN' : 'IN_PROGRESS'))
    const links = random() < 0.45 ? 0 : 1 + Math.floor(random() * 3)
    for (let link = 0; link < links && index > 0; link += 1) {
      const prerequisite = `ticket-stress-${Math.max(0, index - 1 - Math.floor(random() * Math.min(index, 30)))}`
      if (!relations.some(r => r.prerequisite_ticket_id === prerequisite && r.dependent_ticket_id === id)) {
        relations.push({ prerequisite_ticket_id: prerequisite, dependent_ticket_id: id })
      }
    }
  }

  return { tickets, relations }
}

test('a thousand Tickets draw one page at a time in at most six lanes', async ($, on) => {
  world(on, { graph: stressGraph(1000) })
  await $.command.run({ command: 'vh', args: '', origin: ORIGIN, presentation: PRESENTATION })
  for (const surface of SURFACES) {
    const started = Date.now()
    const ui = await $.ui.mount({ plugin: 'vibehub-mod', surface, component: 'Pane', requestId: 'vibehub', props: pane })
    const rows = async () => (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('n:')).length
    expect(await rows()).toBe(40)
    expect((await ui.find({ key: 'more' }))?.text).toMatch(/^Show more \(\d+ left\)$/)
    await ui.press({ key: 'more' })
    expect(await rows()).toBe(80)
    await ui.press({ key: 'finished' })
    expect(await rows()).toBe(40)
    const lanes = await ui.findAll({ type: 'Text', text: /^[│╯╮┼─┆ ]$/ })
    expect(lanes.length).toBeGreaterThan(0)
    expect(await ui.find({ type: 'Text', text: '┆' })).toBeDefined()
    await ui.press({ key: 'finished' })
    expect(Date.now() - started).toBeLessThan(5000)
  }
  const typed = '#stress'
  const prompt = $.prompt as unknown as Completer
  const suggestions = await prompt.autocomplete({ text: typed, cursor: typed.length, token: typed, start: 0 })
  expect(suggestions.suggestions).toHaveLength(8)
})
