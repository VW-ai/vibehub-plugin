export type TicketGroup = 'in_progress' | 'open' | 'blocked'
export type TicketItem = { id: string; title: string | null; outcome: string; group: TicketGroup }
export type ActiveTicket = { id: string; title: string | null; outcome: string }
export type TicketDetail = { id: string; markdown: string }
export type NodeState = 'done' | 'in_progress' | 'open' | 'blocked'
export type GraphNode = { id: string; title: string | null; outcome: string; state: NodeState; col: number; row: number }
export type GraphModel = { nodes: GraphNode[]; edges: { from: string; to: string }[]; standalone: string[] }
export type PaneView = 'graph' | 'list'

declare module 'claude-code' {
  interface PluginState {
    'vibehub-mod': {
      tickets: TicketItem[]
      graph: GraphModel
      view: PaneView
      group: TicketGroup
      selected: string | null
      detail: TicketDetail | null
      active: ActiveTicket | null
      attached: string[]
      error: string | null
    }
  }
}
