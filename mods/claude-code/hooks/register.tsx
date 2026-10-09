import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveTicket, TicketDetail, TicketGroup, TicketItem } from '../types'
import {
  GROUPS, brief, composeSection, detailMarkdown, groupLabel, listTickets, matchTickets, mentions, nameOf, reminder,
} from './brief'
import type { Resolved, Ticket } from './brief'

const COMMAND = 'vh'
const PANE = 'vibehub'
const SECTION = 'vibehub-active-ticket'
const MAX_MENTIONS = 3

const tickets = atom({ plugin: 'vibehub-mod', key: 'tickets' } as const, [] as TicketItem[])
const group = atom({ plugin: 'vibehub-mod', key: 'group' } as const, 'in_progress' as TicketGroup)
const selected = atom({ plugin: 'vibehub-mod', key: 'selected' } as const, null as string | null)
const detail = atom({ plugin: 'vibehub-mod', key: 'detail' } as const, null as TicketDetail | null)
const active = atom({ plugin: 'vibehub-mod', key: 'active' } as const, null as ActiveTicket | null)
const attached = atom({ plugin: 'vibehub-mod', key: 'attached' } as const, [] as string[])
const error = atom({ plugin: 'vibehub-mod', key: 'error' } as const, null as string | null)

type Helper = { root: string; vh: string }

const findHelper = async ($: EngineInterface): Promise<Helper | string> => {
  const root = await $.session.root()
  if (!(await $.fs.exists(`${root}/.vibehub`))) {
    return 'VibeHub is not set up in this project (no .vibehub/ directory).'
  }
  const home = (await $.env.get('HOME')) ?? ''
  const candidates = [
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
    const list = listTickets(await vh($, helper, ['ticket', 'frontier']))
    await update($, tickets, () => list)
    await update($, error, () => null)

    return list
  } catch (cause) {
    await update($, error, () => `Could not read Tickets: ${message(cause)}`)

    return message(cause)
  }
}

const getTicket = async ($: EngineInterface, helper: Helper, id: string): Promise<Ticket> =>
  (await vh($, helper, ['ticket', 'get'], { ticket_id: id })).ticket as Ticket

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
    const list = await read($, tickets)
    const titleOf = (other: string) => {
      const found = list.find(t => t.id === other)

      return found ? nameOf(found, 50) : null
    }
    await update($, detail, () => ({ id, markdown: detailMarkdown(ticket, titleOf) }))
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
    if (target) {
      await update($, group, () => target.group)
      await select($, target.id)
    }
    await $.ui.open({ id: PANE, title: 'VibeHub', focus: true })

    return { text: `VibeHub: ${list.length} unfinished Tickets. Type # in a message to mention one.` }
  }).catch(() => ({ text: 'VibeHub: /vh failed; see the claude --debug log.' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = await read($, tickets)
    const shown = await read($, group)
    const picked = await read($, selected)
    const current = await read($, active)
    const opened = await read($, detail)
    const failed = await read($, error)
    const width = Math.max(16, e.props.bodyColumns - 4)
    const rows = list.filter(t => t.group === shown)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {GROUPS.map(g => (
            <Button
              key={`g:${g.group}`}
              label={`${g.label} ${list.filter(t => t.group === g.group).length}`}
              variant={g.group === shown ? 'primary' : undefined}
              onPress={() => update($, group, () => g.group)}
            />
          ))}
        </Box>
        <Box flexDirection="column">
          {rows.length === 0 && <Text dimColor>Nothing here</Text>}
          {rows.map(t => (
            <Button
              key={`t:${t.id}`}
              plain
              label={`${t.id === current?.id ? '●' : '○'} ${nameOf(t, width)}`}
              dimColor={picked !== null && picked !== t.id}
              onPress={() => select($, t.id)}
            />
          ))}
        </Box>
        {opened !== null && opened.id === picked && <Markdown text={opened.markdown} />}
        {picked !== null && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button
              key="mention"
              variant="primary"
              label="Mention in prompt"
              onPress={async () => {
                const filled = await $.prompt.fill({ text: `#${picked} `, mode: 'insert' })
                if (!filled.isFilled) $.ui.toast('The prompt box is not available right now')
              }}
            />
            <Button
              key="refresh"
              label="Refresh"
              onPress={async () => {
                await refresh($)
                await select($, picked)
              }}
            />
          </Box>
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
