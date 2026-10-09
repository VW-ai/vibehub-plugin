export type TicketGroup = 'in_progress' | 'open' | 'blocked'
export type TicketItem = { id: string; title: string | null; outcome: string; group: TicketGroup }
export type ActiveTicket = { id: string; title: string | null; outcome: string }
export type TicketDetail = { id: string; markdown: string }

declare module 'claude-code' {
  interface PluginState {
    'vibehub-mod': {
      tickets: TicketItem[]
      group: TicketGroup
      selected: string | null
      detail: TicketDetail | null
      active: ActiveTicket | null
      attached: string[]
      error: string | null
    }
  }
}
