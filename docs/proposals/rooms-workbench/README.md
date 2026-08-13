# Rooms in the Workbench proposal

Rooms are an optional knowledge lens over the causal Ticket graph, not a second
navigation system and not a new graph layout.

## Proposed direction

- A compact `Rooms` control in the Workbench header opens a floating Rooms
  browser. No Room panel or left navigation is present by default.
- The tree uses canonical directory containment. It never turns `relates_to`
  or `depends_on` into containment and never invents a hierarchy.
- Drift appears in situ beside the owning Room. `FRESH` is a quiet check and is
  omitted from the closed control; `DRIFTED`, `WARNING`, `STALE`, and
  `COLD_START` use explicit text and the shared compact stroke-SVG icon system,
  not color alone or emoji.
- Selecting a Room opens its detail in the same surface: boundary, anchors,
  canonical Context entries, and Tickets whose `context_refs` consume that Room
  subtree.
- `Show related Tickets` applies the canonical repeated-Room query to the
  existing graph. Non-matching Tickets recede or are filtered; the surviving
  cards keep their exact x/y coordinates and the graph is never re-clustered
  by Room.
- On narrow screens, the same surface is a bottom sheet over a still-visible
  graph. Every interactive target is at least 44px.
- The full Workbench uses the same system monospace stack as Room and Ticket
  identifiers; buttons and prose do not fall back to a separate sans-serif voice.
- Do not repeat what hierarchy and interaction already make clear. The panel
  says `Rooms`, the selected Room says its name, and redundant labels such as
  `Knowledge spaces` or `Selected Room` are omitted. Copy is reserved for
  canonical boundaries, drift facts, errors, and actions whose meaning cannot
  be inferred safely from layout alone.

## Review states

The prototype exposes three states through its own controls:

- focused `workbench`: a FRESH Room with two Context entries and consuming
  Tickets;
- focused `product`: a representative DRIFTED Room with exact changed and
  added file counts rendered in situ;
- no selection: the quiet empty detail state, while the canonical tree remains
  visible.

This is a proposal only. It adds no production Room projection, persisted UI
state, database, cache, Ticket grouping, or writable Web route.
