import type { GraphModel, GraphNode, NodeState } from '../types'

type GraphEntry = { ticket: { ticket_id: string; title?: string; outcome: string }; ticket_state?: { state?: string } }
type GraphRelation = { prerequisite_ticket_id: string; dependent_ticket_id: string }

const STATES: Record<string, NodeState> = { DONE: 'done', IN_PROGRESS: 'in_progress', OPEN: 'open', BLOCKED: 'blocked' }
const STATE_ORDER: NodeState[] = ['in_progress', 'open', 'blocked', 'done']

// A Ticket without a title reads better by its ID than by a clipped outcome.
export const humanize = (id: string): string => {
  const words = id.replace(/^ticket-/, '').replace(/-/g, ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

const label = (node: { id?: string; title: string | null }): string => node.title ?? humanize(node.id ?? '')

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

// Lays the `ticket graph` projection out in columns: a Ticket sits one column
// right of its deepest prerequisite, so work flows left to right. Tickets with
// no relation at all leave the picture and are only counted.
export const buildGraph = (data: Record<string, unknown>): GraphModel => {
  const entries = (data.tickets as GraphEntry[] | undefined) ?? []
  const relations = ((data.relations as GraphRelation[] | undefined) ?? [])
  const byId = new Map(entries.map(e => [e.ticket.ticket_id, e]))
  const edges = relations
    .filter(r => byId.has(r.prerequisite_ticket_id) && byId.has(r.dependent_ticket_id))
    .map(r => ({ from: r.prerequisite_ticket_id, to: r.dependent_ticket_id }))
  const linked = new Set(edges.flatMap(e => [e.from, e.to]))
  const prerequisites = (id: string) => edges.filter(e => e.to === id).map(e => e.from)
  const depth = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    depth.set(id, 0)
    const value = Math.max(-1, ...prerequisites(id).map(depthOf)) + 1
    depth.set(id, value)

    return value
  }
  const stateOf = (id: string): NodeState => STATES[byId.get(id)?.ticket_state?.state ?? ''] ?? 'open'
  const columns: string[][] = []
  for (const id of [...linked].sort()) (columns[depthOf(id)] ??= []).push(id)
  const row = new Map<string, number>()
  columns.forEach((ids, col) => {
    const weight = (id: string) => {
      const rows = prerequisites(id).map(p => row.get(p) ?? 0)

      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : 0
    }
    ids.sort((a, b) =>
      (col === 0 ? STATE_ORDER.indexOf(stateOf(a)) - STATE_ORDER.indexOf(stateOf(b)) : weight(a) - weight(b))
      || a.localeCompare(b))
    ids.forEach((id, index) => row.set(id, index))
  })
  const nodes: GraphNode[] = columns.flatMap((ids, col) => ids.map((id, index) => {
    const { ticket } = byId.get(id)!

    return { id, title: ticket.title ?? null, outcome: ticket.outcome, state: stateOf(id), col, row: index }
  }))
  const standalone = entries
    .filter(e => !linked.has(e.ticket.ticket_id) && stateOf(e.ticket.ticket_id) !== 'done')
    .map(e => e.ticket.ticket_id)

  return { nodes, edges, standalone }
}

export type GraphRow = { id: string; prerequisites: string[] }

// Each unfinished Ticket that waits on others, in left-to-right order. A
// Ticket nothing waits on before it appears only as a prerequisite chip.
export const graphRows = (graph: GraphModel): GraphRow[] =>
  [...graph.nodes]
    .filter(n => n.state !== 'done')
    .sort((a, b) => a.col - b.col || a.row - b.row)
    .map(n => ({ id: n.id, prerequisites: graph.edges.filter(e => e.to === n.id).map(e => e.from) }))
    .filter(row => row.prerequisites.length > 0)

const CHIP_W = 150
const CHIP_H = 22
const CHIP_GAP = 6
const CARD_W = 170
const CARD_H = 30
const LINK_W = 34
const ROW_GAP = 16
const PAD = 8

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The desktop picture: one group per waiting Ticket, its prerequisites as
// chips on the left joined to its card on the right, groups stacked down so a
// narrow pane fits. It follows the light or dark theme and gives each box a
// tooltip; presses happen on the Buttons beside it, not in the SVG.
export const graphSvg = (graph: GraphModel, session: string | null, selected: string | null): string => {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const classes = (id: string, ...more: string[]) =>
    [byId.get(id)?.state ?? 'open', id === session ? 'session' : '', id === selected ? 'selected' : '', ...more].filter(Boolean).join(' ')
  const tip = (id: string) => {
    const node = byId.get(id)!

    return `<title>${escape(`${label({ id, title: node.title })}\n#${id} · ${node.state.replace('_', ' ')}`)}</title>`
  }
  const dot = (id: string, x: number, y: number) =>
    byId.get(id)?.state === 'done' ? '' : `<circle class="dot" cx="${x}" cy="${y}" r="3.5"/>`
  const parts: string[] = []
  let y = PAD
  for (const row of graphRows(graph)) {
    const chipsHeight = row.prerequisites.length * CHIP_H + (row.prerequisites.length - 1) * CHIP_GAP
    const height = Math.max(chipsHeight, CARD_H)
    const cardX = PAD + CHIP_W + LINK_W
    const cardY = y + (height - CARD_H) / 2
    row.prerequisites.forEach((id, index) => {
      const chipY = y + (height - chipsHeight) / 2 + index * (CHIP_H + CHIP_GAP)
      const done = byId.get(id)?.state === 'done'
      const startX = PAD + CHIP_W
      const startY = chipY + CHIP_H / 2
      const endY = cardY + CARD_H / 2
      const mid = startX + LINK_W / 2
      parts.push(`<path class="edge${byId.get(row.id)?.state === 'blocked' ? ' to-blocked' : ''}" d="M${startX} ${startY} C${mid} ${startY},${mid} ${endY},${cardX - 4} ${endY}" marker-end="url(#arrow)"/>`)
      parts.push(`<g class="chip ${classes(id)}">${tip(id)}<rect x="${PAD}" y="${chipY}" width="${CHIP_W}" height="${CHIP_H}" rx="5"/>`
        + `${dot(id, PAD + 10, chipY + CHIP_H / 2)}<text x="${PAD + (done ? 8 : 19)}" y="${chipY + 15}">${escape(clip(label({ id, title: byId.get(id)!.title }), done ? 26 : 24))}</text></g>`)
    })
    parts.push(`<g class="card ${classes(row.id)}">${tip(row.id)}<rect x="${cardX}" y="${cardY}" width="${CARD_W}" height="${CARD_H}" rx="7"/>`
      + `${dot(row.id, cardX + 12, cardY + CARD_H / 2)}<text x="${cardX + 22}" y="${cardY + 19}">${escape(clip(label({ id: row.id, title: byId.get(row.id)!.title }), 25))}</text></g>`)
    y += height + ROW_GAP
  }
  const width = PAD * 2 + CHIP_W + LINK_W + CARD_W
  const height = Math.max(y - ROW_GAP + PAD, PAD * 2)

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" style="max-width:${width}px" font-family="-apple-system, system-ui, sans-serif" font-size="11">`,
    '<style>',
    ':root{--fg:#1f1f1d;--muted:#8a8984;--line:#c9c7bf;--card:#ffffff;--faded:#f3f2ee;--green:#1D9E75;--amber:#BA7517;--blue:#378ADD}',
    '@media (prefers-color-scheme: dark){:root{--fg:#ecebe6;--muted:#9a9993;--line:#55544f;--card:#262624;--faded:#1d1d1b}}',
    '.edge{fill:none;stroke:var(--line);stroke-width:1.2}.edge.to-blocked{stroke:var(--amber);stroke-width:1.5}',
    'rect{fill:var(--card);stroke:var(--line);stroke-width:1.1}text{fill:var(--fg)}.chip text{font-size:10.5px}',
    '.done rect{fill:var(--faded)}.done text{fill:var(--muted)}.chip.done{opacity:.7}',
    '.dot{fill:none;stroke:var(--muted);stroke-width:1.4}.in_progress .dot{fill:var(--green);stroke:var(--green)}',
    '.blocked rect{stroke:var(--amber);stroke-dasharray:4 3}.session rect{stroke:var(--green);stroke-width:2}',
    '.session .dot{fill:var(--green);stroke:var(--green)}.selected rect{stroke:var(--blue);stroke-width:2.2}',
    'g:hover rect{stroke:var(--blue)}#arrow path{fill:var(--line)}',
    '</style>',
    '<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L8 4L0 8z"/></marker></defs>',
    ...parts,
    '</svg>',
  ].join('')
}

export const dependentsOf = (graph: GraphModel, id: string): string[] =>
  graph.edges.filter(e => e.from === id).map(e => e.to)
