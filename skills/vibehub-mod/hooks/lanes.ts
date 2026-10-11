import type { LaneFilter, NodeState } from '../types'

type Entry = { ticket: { ticket_id: string; title?: string; outcome: string }; ticket_state?: { state?: string } }
type Relation = { prerequisite_ticket_id: string; dependent_ticket_id: string }

export type Cell = { glyph: string; icon?: NodeState }
export type LaneRow = {
  id: string
  state: NodeState
  // The lane glyphs on the Ticket's own line, and on the line under it.
  head: Cell[]
  tail: Cell[]
  waitingOn: string[]
  unblocks: string[]
  finishedPrerequisites: number
}
export type LaneGraph = { rows: LaneRow[]; width: number; counts: Record<NodeState, number> }

const STATES: Record<string, NodeState> = { DONE: 'done', IN_PROGRESS: 'in_progress', OPEN: 'open', BLOCKED: 'blocked' }
const PRIORITY: NodeState[] = ['in_progress', 'open', 'blocked', 'done']
export const MAX_LANES = 6

export const ICONS: Record<NodeState, string> = { in_progress: '◉', open: '▶', blocked: '⊘', done: '✓' }

// A Ticket without a title reads better by its ID than by a clipped outcome.
export const humanize = (id: string): string => {
  const words = id.replace(/^ticket-/, '').replace(/-/g, ' ')

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

// Rows of a `ticket graph` projection drawn top to bottom like `git log
// --graph`: a prerequisite sits above the Tickets that wait on it and a lane
// carries each dependency down to them. Related Tickets stay together, and
// groups holding work in progress come first.
export const buildLanes = (data: Record<string, unknown>, filter: LaneFilter, showFinished: boolean): LaneGraph => {
  const entries = (data.tickets as Entry[] | undefined) ?? []
  const relations = (data.relations as Relation[] | undefined) ?? []
  const stateOf = new Map(entries.map(e => [e.ticket.ticket_id, STATES[e.ticket_state?.state ?? ''] ?? 'open']))
  const counts: Record<NodeState, number> = { in_progress: 0, open: 0, blocked: 0, done: 0 }
  for (const state of stateOf.values()) counts[state] += 1
  const shown = new Set([...stateOf].filter(([, state]) =>
    state === 'done' ? false : filter === 'all' || state === filter).map(([id]) => id))
  const edges = relations.filter(r => stateOf.has(r.prerequisite_ticket_id) && stateOf.has(r.dependent_ticket_id))
  if (showFinished) {
    for (const r of edges) if (shown.has(r.dependent_ticket_id) && stateOf.get(r.prerequisite_ticket_id) === 'done') shown.add(r.prerequisite_ticket_id)
  }
  const index = (pairs: [string, string][]) => {
    const map = new Map<string, string[]>()
    for (const [key, value] of pairs) map.set(key, [...(map.get(key) ?? []), value])

    return (id: string) => map.get(id) ?? []
  }
  const visible = edges.filter(r => shown.has(r.prerequisite_ticket_id) && shown.has(r.dependent_ticket_id))
  const after = index(visible.map(r => [r.prerequisite_ticket_id, r.dependent_ticket_id]))
  const before = index(visible.map(r => [r.dependent_ticket_id, r.prerequisite_ticket_id]))
  const prerequisitesOf = index(edges.map(r => [r.dependent_ticket_id, r.prerequisite_ticket_id]))
  const dependentsOf = index(edges.map(r => [r.prerequisite_ticket_id, r.dependent_ticket_id]))
  const rank = (id: string) => PRIORITY.indexOf(stateOf.get(id)!)

  // Weakly connected groups, the busiest first, each in dependency order.
  const seen = new Set<string>()
  const groups: string[][] = []
  for (const start of [...shown].sort()) {
    if (seen.has(start)) continue
    const group: string[] = []
    const stack = [start]
    while (stack.length) {
      const id = stack.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      group.push(id)
      stack.push(...after(id), ...before(id))
    }
    groups.push(group)
  }
  const groupRank = (group: string[]) => Math.min(...group.map(rank)) * 2 - (group.length > 1 ? 1 : 0)
  groups.sort((a, b) => groupRank(a) - groupRank(b) || a.length - b.length || a[0]!.localeCompare(b[0]!))
  // Within a group, the next row is the ready Ticket whose prerequisites were
  // drawn most recently, so a lane ends soon after it starts.
  const order: string[] = []
  const drawnAt = new Map<string, number>()
  for (const group of groups) {
    const waiting = new Map(group.map(id => [id, before(id).length]))
    const ready = group.filter(id => waiting.get(id) === 0)
    const recency = (id: string) => Math.max(-1, ...before(id).map(p => drawnAt.get(p) ?? -1))
    while (ready.length) {
      ready.sort((a, b) => recency(b) - recency(a) || rank(a) - rank(b) || a.localeCompare(b))
      const id = ready.shift()!
      drawnAt.set(id, order.length)
      order.push(id)
      for (const next of after(id)) {
        waiting.set(next, waiting.get(next)! - 1)
        if (waiting.get(next) === 0) ready.push(next)
      }
    }
  }

  // Lanes: each holds the Ticket its dependency is travelling down to.
  const lanes: (string | null)[] = []
  const rows: LaneRow[] = order.map(id => {
    const incoming = lanes.flatMap((target, index) => (target === id ? [index] : []))
    let col = incoming.length ? Math.min(...incoming) : lanes.indexOf(null)
    if (col < 0) col = lanes.length
    const head: Cell[] = []
    const last = Math.max(col, ...incoming, lanes.length - 1)
    for (let index = 0; index <= last; index += 1) {
      const merging = incoming.includes(index) && index !== col
      const crossed = index > col && index < Math.max(...incoming, col)
      if (index === col) head[index] = { glyph: ICONS[stateOf.get(id)!], icon: stateOf.get(id)! }
      else if (merging) head[index] = { glyph: '╯' }
      else if (crossed) head[index] = { glyph: lanes[index] ? '┼' : '─' }
      else head[index] = { glyph: lanes[index] ? '│' : ' ' }
    }
    for (const index of incoming) lanes[index] = null
    const dependents = after(id)
    if (dependents.length) {
      lanes[col] = dependents[0]!
      for (const next of dependents.slice(1)) {
        let slot = lanes.findIndex((target, index) => target === null && index > col && !incoming.includes(index))
        if (slot < 0) slot = Math.max(lanes.length, col + 1)
        for (let index = col + 1; index < slot; index += 1) {
          if (head[index]?.glyph === ' ' || head[index] === undefined) head[index] = { glyph: '─' }
          else if (head[index]?.glyph === '│') head[index] = { glyph: '┼' }
        }
        head[slot] = { glyph: '╮' }
        lanes[slot] = next
      }
    } else lanes[col] = null
    while (lanes.length && lanes.at(-1) === null) lanes.pop()
    const tail: Cell[] = lanes.map(target => ({ glyph: target ? '│' : ' ' }))
    const prerequisites = prerequisitesOf(id)

    return {
      id,
      state: stateOf.get(id)!,
      head,
      tail,
      waitingOn: prerequisites.filter(p => stateOf.get(p) !== 'done'),
      unblocks: dependentsOf(id).filter(d => stateOf.get(d) !== 'done'),
      finishedPrerequisites: showFinished ? 0 : prerequisites.filter(p => stateOf.get(p) === 'done').length,
    }
  })
  const width = Math.max(1, ...rows.map(row => Math.max(row.head.length, row.tail.length)))
  if (width <= MAX_LANES) return { rows, width, counts }

  // A dense graph is wide however it is ordered. Past the last visible lane,
  // every lane folds into one dotted column; a Ticket in it still shows its
  // mark, and its row's text still names what it waits on and unblocks.
  const fold = (cells: Cell[]): Cell[] => {
    const kept = cells.slice(0, MAX_LANES - 1)
    const rest = cells.slice(MAX_LANES - 1)
    const icon = rest.find(cell => cell.icon)
    kept.push(icon ?? { glyph: rest.some(cell => cell.glyph.trim()) ? '┆' : ' ' })

    return kept
  }

  return { rows: rows.map(row => ({ ...row, head: fold(row.head), tail: fold(row.tail) })), width: MAX_LANES, counts }
}
