import type { TicketGroup, TicketItem } from '../types'

export type ContextRef = { ref: string; purpose?: string }
export type Resolved = { ref: string; purpose?: string; source: string | null }

export type Ticket = {
  ticket_id: string
  title?: string
  outcome: string
  status?: string
  context?: string
  constraints?: string[]
  acceptance?: { criterion: string; state?: string }[]
  relations?: { type: string; target_ticket_id: string; rationale?: string }[]
  context_refs?: ContextRef[]
  updates?: { summary: string; status?: string; recorded_at?: string }[]
}

type FrontierEntry = { ticket: Ticket }

// Records and prose are inlined; code and anything past the budget is listed
// so the agent reads it on demand instead of carrying it in every request.
const INLINE_BUDGET = 40_000
const INLINE_EXT = /\.(ya?ml|md|json|txt)$/i
const MENTION = /(?:^|[\s(（])#([a-z0-9]+(?:-[a-z0-9]+)*)/g

export const GROUPS: { group: TicketGroup; label: string }[] = [
  { group: 'in_progress', label: 'In progress' },
  { group: 'open', label: 'Ready' },
  { group: 'blocked', label: 'Blocked' },
]

export const groupLabel = (group: TicketGroup): string => GROUPS.find(g => g.group === group)?.label ?? group

export const shorten = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

export const nameOf = (ticket: { title?: string | null; outcome: string }, max = 60): string =>
  ticket.title ?? shorten(ticket.outcome, max)

export const listTickets = (data: Record<string, unknown>): TicketItem[] =>
  GROUPS.flatMap(({ group }) =>
    ((data[group] as FrontierEntry[] | undefined) ?? []).map(({ ticket }) => ({
      id: ticket.ticket_id,
      title: ticket.title ?? null,
      outcome: ticket.outcome,
      group,
    })),
  )

export const listingText = (tickets: TicketItem[]): string => {
  if (tickets.length === 0) return 'VibeHub: no unfinished Tickets.'
  const lines = GROUPS.flatMap(({ group, label }) => {
    const rows = tickets.filter(t => t.group === group)

    return rows.length ? [`${label} ${rows.length}`, ...rows.map(t => `- #${t.id}  ${nameOf(t, 70)}`)] : []
  })

  return `VibeHub: ${tickets.length} unfinished Tickets. Mention one with #ticket-id.\n${lines.join('\n')}`
}

export const matchTickets = (tickets: TicketItem[], query: string, limit = 8): TicketItem[] => {
  const q = query.toLowerCase()
  const hits = q
    ? tickets.filter(t => [t.id, t.title ?? '', t.outcome].some(field => field.toLowerCase().includes(q)))
    : tickets

  return hits.slice(0, limit)
}

export const mentions = (text: string, known: Set<string>): string[] => {
  const found: string[] = []
  for (const match of text.matchAll(MENTION)) {
    const id = match[1]!
    if (known.has(id) && !found.includes(id)) found.push(id)
  }

  return found
}

export const brief = (ticket: Ticket, resolved: Resolved[]): string => {
  const out: string[] = [
    `# VibeHub Ticket #${ticket.ticket_id}${ticket.title ? `: ${ticket.title}` : ''}`,
    'The user mentioned this Ticket in their message. Its record and related context follow so you can understand the message.',
    'Use the vibehub-ticket Skill to record progress or completion.',
    '',
    `Outcome: ${ticket.outcome}`,
  ]
  if (ticket.status) out.push(`Recorded status: ${ticket.status}`)
  if (ticket.context) out.push('', '## Background', ticket.context)
  if (ticket.constraints?.length) out.push('', '## Constraints', ...ticket.constraints.map(c => `- ${c}`))
  if (ticket.acceptance?.length) {
    out.push('', '## Acceptance', ...ticket.acceptance.map(a => `- ${a.criterion}${a.state && a.state !== 'active' ? ` (${a.state})` : ''}`))
  }
  if (ticket.relations?.length) {
    out.push('', '## Relations', ...ticket.relations.map(r => `- ${r.type} #${r.target_ticket_id}${r.rationale ? `: ${r.rationale}` : ''}`))
  }
  const updates = ticket.updates ?? []
  if (updates.length) {
    out.push('', '## Recent progress', ...updates.slice(-3).map(u => `- ${u.recorded_at?.slice(0, 10) ?? ''} ${u.status ? `[${u.status}] ` : ''}${u.summary}`))
  }

  let budget = INLINE_BUDGET
  const inlined: string[] = []
  const listed: string[] = []
  for (const item of resolved) {
    const label = `${item.ref}${item.purpose ? ` — ${item.purpose}` : ''}`
    const path = item.ref.replace(/^commit:[0-9a-f]+:/, '')
    if (item.source !== null && INLINE_EXT.test(path) && item.source.length <= budget) {
      budget -= item.source.length
      inlined.push('', `### ${label}`, '````', item.source.trimEnd(), '````')
    } else {
      listed.push(`- ${label}${item.source === null ? ' (unresolved)' : ''}`)
    }
  }
  if (inlined.length) out.push('', '## Context', ...inlined)
  if (listed.length) out.push('', '## Other references (read when needed)', ...listed)

  return out.join('\n')
}

// A Ticket already attached earlier in the session is named, not repeated.
export const reminder = (ticket: { id: string; title: string | null; outcome: string }): string =>
  `The user mentioned VibeHub Ticket #${ticket.id} (${nameOf(ticket, 120)}) again. Its full record is earlier in this session; read .vibehub/tickets/${ticket.id}.yaml for the latest state.`

export const detailMarkdown = (ticket: Ticket, titleOf: (id: string) => string | null): string => {
  const out: string[] = [`**${ticket.title ?? shorten(ticket.outcome, 80)}**`, `\`#${ticket.ticket_id}\` · ${ticket.status ?? 'open'}`, '', ticket.outcome]
  if (ticket.constraints?.length) out.push('', `**Constraints ${ticket.constraints.length}**`, ...ticket.constraints.map(c => `- ${c}`))
  const active = (ticket.acceptance ?? []).filter(a => (a.state ?? 'active') === 'active')
  if (active.length) out.push('', `**Acceptance ${active.length}**`, ...active.map(a => `- ${a.criterion}`))
  const deps = (ticket.relations ?? []).filter(r => r.type === 'depends_on')
  if (deps.length) out.push('', `**Depends on ${deps.length}**`, ...deps.map(r => `- ${titleOf(r.target_ticket_id) ?? r.target_ticket_id}`))
  const refs = ticket.context_refs ?? []
  if (refs.length) out.push('', `**Context ${refs.length}**`, ...refs.map(r => `- \`${r.ref.replace(/^commit:[0-9a-f]{7}[0-9a-f]*:/, '')}\``))
  const updates = ticket.updates ?? []
  if (updates.length) {
    out.push('', '**Recent progress**', ...updates.slice(-3).reverse().map(u => `- ${u.recorded_at?.slice(5, 10) ?? ''} ${shorten(u.summary, 70)}`))
  }

  return out.join('\n')
}

export const composeSection = (active: { id: string; title: string | null; outcome: string }): string =>
  `This session is working on VibeHub Ticket #${active.id}: ${nameOf(active, 200)}. Read .vibehub/tickets/${active.id}.yaml for details and use the vibehub-ticket Skill to record progress.`
