import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveTicket, LaneData, LaneFilter, NodeState, TicketDetail, TicketItem } from '../types'
import {
  brief, composeSection, detailMarkdown, groupLabel, listTickets, listingText, matchTickets, mentions, nameOf, reminder,
} from './brief'
import type { Resolved, Ticket } from './brief'
import { buildLanes, clip, humanize } from './lanes'
import type { Cell, LaneRow } from './lanes'

const COMMAND = 'vh'
// Theme colors, so the marks follow light and dark; the same words and
// meaning as the dashboard's lanes.
const STATE_COLOR: Record<NodeState, string> = { in_progress: 'suggestion', open: 'success', blocked: 'inactive', done: 'subtle' }
const STATE_LABEL: Record<NodeState, string> = { in_progress: 'In progress', open: 'Open', blocked: 'Blocked', done: 'Done' }
const PANE = 'vibehub'
const SECTION = 'vibehub-active-ticket'
const MAX_MENTIONS = 3

const tickets = atom({ plugin: 'vibehub-mod', key: 'tickets' } as const, [] as TicketItem[])
const lanes = atom({ plugin: 'vibehub-mod', key: 'lanes' } as const, { tickets: [], relations: [] } as LaneData)
const filter = atom({ plugin: 'vibehub-mod', key: 'filter' } as const, 'all' as LaneFilter)
const finished = atom({ plugin: 'vibehub-mod', key: 'finished' } as const, false)
// Rows drawn at once; a long list grows by a page at a press.
const PAGE = 40
const limit = atom({ plugin: 'vibehub-mod', key: 'limit' } as const, PAGE)
const selected = atom({ plugin: 'vibehub-mod', key: 'selected' } as const, null as string | null)
const detail = atom({ plugin: 'vibehub-mod', key: 'detail' } as const, null as TicketDetail | null)
const active = atom({ plugin: 'vibehub-mod', key: 'active' } as const, null as ActiveTicket | null)
const attached = atom({ plugin: 'vibehub-mod', key: 'attached' } as const, [] as string[])
const error = atom({ plugin: 'vibehub-mod', key: 'error' } as const, null as string | null)

type Helper = { root: string; vh: string }

// Full records from the last graph read; details and briefs use them instead
// of another read. A reload empties it until the next refresh.
let records = new Map<string, Ticket>()

const findHelper = async ($: EngineInterface): Promise<Helper | string> => {
  const root = await $.session.root()
  if (!(await $.fs.exists(`${root}/.vibehub`))) {
    return 'VibeHub is not set up in this project (no .vibehub/ directory).'
  }
  const home = (await $.env.get('HOME')) ?? ''
  // Installed by npx skills add, the mod sits beside vibehub-core.
  const candidates = [
    `${$.plugin.root}/../vibehub-core/scripts/vh.mjs`,
    `${root}/.claude/skills/vibehub-core/scripts/vh.mjs`,
    `${root}/.agents/skills/vibehub-core/scripts/vh.mjs`,
    `${home}/.claude/skills/vibehub-core/scripts/vh.mjs`,
    `${home}/.agents/skills/vibehub-core/scripts/vh.mjs`,
  ]
  for (const vh of candidates) {
    if (await $.fs.exists(vh)) return { root, vh }
  }

  return 'The vibehub-core helper is missing. Install it with npx skills add VW-ai/vibehub-plugin -s vibehub-core.'
}

const vh = async ($: EngineInterface, helper: Helper, args: string[], input?: unknown) => {
  const argv = ['node', helper.vh, ...args, '--repo', helper.root]
  const ran = await $.process.run(
    input === undefined ? argv : [...argv, '--input', '-'],
    { cwd: helper.root, stdin: input === undefined ? undefined : JSON.stringify(input), timeoutMs: 20_000 },
  )
  const parsed = JSON.parse(ran.stdout || '{}') as { ok?: boolean; data?: unknown; error?: { message?: string } }
  if (!parsed.ok) throw new Error(parsed.error?.message ?? (ran.stderr.trim() || `vh.mjs exited ${ran.exitCode}`))

  return parsed.data as Record<string, unknown>
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const refresh = async ($: EngineInterface): Promise<TicketItem[] | string> => {
  const helper = await findHelper($)
  if (typeof helper === 'string') return helper
  try {
    const data = await vh($, helper, ['ticket', 'graph'])
    const listed = listTickets(data)
    records = listed.records
    await update($, tickets, () => listed.tickets)
    await update($, lanes, () => laneData(data))
    await update($, error, () => null)

    return listed.tickets
  } catch (cause) {
    await update($, error, () => `Could not read Tickets: ${message(cause)}`)

    return message(cause)
  }
}

// Only what the lanes need, so the session state stays small.
const laneData = (data: Record<string, unknown>): LaneData => ({
  tickets: ((data.tickets as LaneData['tickets'] | undefined) ?? []).map(({ ticket, ticket_state }) => ({
    ticket: { ticket_id: ticket.ticket_id, title: ticket.title, outcome: ticket.outcome },
    ticket_state: { state: ticket_state?.state ?? 'OPEN' },
  })),
  relations: ((data.relations as LaneData['relations'] | undefined) ?? [])
    .map(({ prerequisite_ticket_id, dependent_ticket_id }) => ({ prerequisite_ticket_id, dependent_ticket_id })),
})

const getTicket = async ($: EngineInterface, helper: Helper, id: string): Promise<Ticket> =>
  records.get(id) ?? ((await vh($, helper, ['ticket', 'get'], { ticket_id: id })).ticket as Ticket)

const titleOf = (id: string): string | null => {
  const record = records.get(id)

  return record ? (record.title ?? humanize(id)) : null
}

const resolveRefs = async ($: EngineInterface, helper: Helper, ticket: Ticket): Promise<Resolved[]> =>
  Promise.all(
    (ticket.context_refs ?? []).map(async ({ ref, purpose }) => {
      try {
        const data = await vh($, helper, ['context', 'resolve'], { ref })

        return { ref, purpose, source: typeof data.source === 'string' ? data.source : null }
      } catch {
        return { ref, purpose, source: null }
      }
    }),
  )

const select = async ($: EngineInterface, id: string) => {
  await update($, selected, () => id)
  const helper = await findHelper($)
  if (typeof helper === 'string') {
    await update($, error, () => helper)
    return
  }
  try {
    const ticket = await getTicket($, helper, id)
    const data = await read($, lanes)
    const done = new Set(data.tickets.filter(t => t.ticket_state.state === 'DONE').map(t => t.ticket.ticket_id))
    const unblocks = data.relations
      .filter(r => r.prerequisite_ticket_id === id && !done.has(r.dependent_ticket_id))
      .map(r => r.dependent_ticket_id)
    await update($, detail, () => ({ id, markdown: detailMarkdown(ticket, titleOf, unblocks) }))
  } catch (cause) {
    await update($, error, () => `Could not read ${id}: ${message(cause)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Open the VibeHub pane to browse Tickets; mention one with # in a message',
      argumentHint: '[ticket-id]',
    })
    void refresh($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const list = await refresh($)
    if (typeof list === 'string') return { text: list }
    const id = e.args.trim().replace(/^#/, '')
    const target = list.find(t => t.id === id)
    if (target) await select($, target.id)
    try {
      await $.ui.open({ id: PANE, title: 'VibeHub', focus: true })
    } catch {
      // No surface can seat a pane, as in claude -p: answer with the list.
      return { text: listingText(list) }
    }

    return { text: `VibeHub: ${list.length} unfinished Tickets. Type # in a message to mention one.` }
  }).catch(() => ({ text: 'VibeHub: /vh failed; see the claude --debug log.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const shownFilter = await read($, filter)
    const showFinished = await read($, finished)
    const graph = buildLanes(await read($, lanes), shownFilter, showFinished)
    const shownRows = graph.rows.slice(0, await read($, limit))
    const picked = await read($, selected)
    const current = await read($, active)
    const opened = await read($, detail)
    const failed = await read($, error)
    const nameWidth = Math.max(12, e.props.bodyColumns - graph.width * 2 - 18)
    const name = (id: string) => titleOf(id) ?? humanize(id)
    const names = (ids: string[]) => (ids.length === 1 ? clip(name(ids[0]!), 40) : `${ids.length} Tickets`)
    const subline = (row: LaneRow) => [
      row.waitingOn.length ? `waiting on ${names(row.waitingOn)}` : '',
      row.unblocks.length ? `unblocks ${names(row.unblocks)}` : '',
      row.finishedPrerequisites ? `built on ${row.finishedPrerequisites} finished` : '',
    ].filter(Boolean).join(' · ') || 'no dependencies'
    const gutter = (cells: Cell[], key: string) => (
      <Box key={key} flexDirection="row" width={graph.width * 2} flexShrink={0}>
        {Array.from({ length: graph.width }, (_, index) => {
          const cell = cells[index]

          return (
            <Box key={`${key}:${index}`} width={2} flexShrink={0}>
              {cell?.icon
                ? <Text color={STATE_COLOR[cell.icon]} bold={cell.icon !== 'done'}>{cell.glyph}</Text>
                : <Text dimColor>{cell?.glyph ?? ' '}</Text>}
            </Box>
          )
        })}
      </Box>
    )
    const chip = (key: LaneFilter, label: string, count: number) => (
      <Button
        key={`f:${key}`}
        label={`${label} ${count}`}
        variant={shownFilter === key ? 'primary' : undefined}
        onPress={async () => {
          await update($, filter, () => key)
          await update($, limit, () => PAGE)
        }}
      />
    )
    const unfinished = graph.counts.in_progress + graph.counts.open + graph.counts.blocked

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {chip('all', 'All', unfinished)}
          {graph.counts.in_progress > 0 && chip('in_progress', 'In progress', graph.counts.in_progress)}
          {chip('open', 'Open', graph.counts.open)}
          {graph.counts.blocked > 0 && chip('blocked', 'Blocked', graph.counts.blocked)}
          <Button
            key="finished"
            label={showFinished ? 'Hide finished' : 'Show finished'}
            variant={showFinished ? 'primary' : undefined}
            onPress={async () => {
              await update($, finished, shown => !shown)
              await update($, limit, () => PAGE)
            }}
          />
        </Box>
        <Box flexDirection="column">
          {graph.rows.length === 0 && <Text dimColor>Nothing here</Text>}
          {shownRows.map(row => (
            <Box key={`r:${row.id}`} flexDirection="column">
              <Box flexDirection="row">
                {gutter(row.head, `h:${row.id}`)}
                <Button
                  key={`n:${row.id}`}
                  plain
                  label={clip(name(row.id), nameWidth)}
                  dimColor={row.state === 'done'}
                  onPress={() => select($, row.id)}
                />
                <Text color={row.id === current?.id ? 'success' : STATE_COLOR[row.state]} dimColor={row.state === 'done'}>
                  {'  '}{row.id === current?.id ? '● this session' : STATE_LABEL[row.state]}
                </Text>
              </Box>
              {(row.state !== 'done' || row.id === picked) && (
                <Box flexDirection="row">
                  {gutter(row.tail, `t:${row.id}`)}
                  <Box flexDirection="column" flexGrow={1}>
                    {row.state !== 'done' && <Text dimColor wrap="truncate-end">{subline(row)}</Text>}
                    {row.id === picked && opened !== null && opened.id === picked && (
                      <Box flexDirection="column" gap={1} marginY={1}>
                        <Markdown text={opened.markdown} />
                        <Box flexDirection="row" gap={1}>
                          <Button
                            key="mention"
                            variant="primary"
                            label="Mention in prompt"
                            onPress={async () => {
                              const filled = await $.prompt.fill({ text: `#${picked} `, mode: 'insert' })
                              if (!filled.isFilled) $.ui.toast('The prompt box is not available right now')
                            }}
                          />
                          <Button key="close" label="Close" onPress={() => update($, selected, () => null)} />
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Box>
              )}
            </Box>
          ))}
        </Box>
        {graph.rows.length > shownRows.length && (
          <Button
            key="more"
            label={`Show more (${graph.rows.length - shownRows.length} left)`}
            onPress={() => update($, limit, shown => (shown ?? PAGE) + PAGE)}
          />
        )}
        {failed !== null && <Text color="error">{failed}</Text>}
      </Box>
    )
  })

  on('prompt.autocomplete', { token: /^#/ }, async ($, e, next) => {
    const base = await next(e)
    const list = await read($, tickets)
    if (list.length === 0) void refresh($).catch(() => undefined)
    const hits = matchTickets(list, e.token.slice(1)).map(t => ({
      text: `#${t.id}`,
      label: nameOf(t, 50),
      description: `${groupLabel(t.group)} · #${t.id}`,
    }))

    return { suggestions: [...base.suggestions, ...hits] }
  })

  // A #ticket-id in the person's message carries that Ticket's record and
  // context to the model beside the prompt; the transcript shows only the text.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || !e.text.includes('#')) return next(e)
    let list = await read($, tickets)
    if (list.length === 0) {
      const fresh = await refresh($)
      if (typeof fresh === 'string') return next(e)
      list = fresh
    }
    const ids = mentions(e.text, new Set(list.map(t => t.id))).slice(0, MAX_MENTIONS)
    if (ids.length === 0) return next(e)
    const helper = await findHelper($)
    if (typeof helper === 'string') return next(e)
    const seen = await read($, attached)
    const blocks = await Promise.all(ids.map(async id => {
      const item = list.find(t => t.id === id)!
      if (seen.includes(id)) return reminder(item)
      const ticket = await getTicket($, helper, id)

      return brief(ticket, await resolveRefs($, helper, ticket))
    }))
    await update($, attached, prior => [...new Set([...(prior ?? []), ...ids])])
    const first = list.find(t => t.id === ids[0])!
    await update($, active, () => ({ id: first.id, title: first.title, outcome: first.outcome }))
    $.ui.toast(`Context attached: ${ids.map(id => nameOf(list.find(t => t.id === id)!, 30)).join(', ')}`)

    return next({ ...e, context: [...(e.context ?? []), ...blocks] })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const current = await read($, active)
    if (current === null) return composed

    return { sections: [...composed.sections, { id: SECTION, scope: 'session', text: composeSection(current) }] }
  })
}
