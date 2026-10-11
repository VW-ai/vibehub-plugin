export type TicketGroup = 'in_progress' | 'open' | 'blocked'
export type TicketItem = { id: string; title: string | null; outcome: string; group: TicketGroup }
export type ActiveTicket = { id: string; title: string | null; outcome: string }
export type TicketDetail = { id: string; markdown: string }
export type NodeState = 'done' | 'in_progress' | 'open' | 'blocked'
export type LaneFilter = 'all' | 'in_progress' | 'open' | 'blocked'
// The slice of a `ticket graph` read the lanes are drawn from.
export type LaneData = {
  tickets: { ticket: { ticket_id: string; title?: string; outcome: string }; ticket_state: { state: string } }[]
  relations: { prerequisite_ticket_id: string; dependent_ticket_id: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'vibehub-mod': {
      tickets: TicketItem[]
      lanes: LaneData
      filter: LaneFilter
      finished: boolean
      limit: number
      selected: string | null
      detail: TicketDetail | null
      active: ActiveTicket | null
      attached: string[]
      error: string | null
    }
  }
}
