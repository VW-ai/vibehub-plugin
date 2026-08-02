<p align="center">
  <img src="assets/brand/vibehub-logo.svg" alt="VibeHub" width="360">
</p>

<h3 align="center">Ticket-driven development for coding agents.</h3>

<p align="center">
  Keep the work executable. Keep the meaning durable. See the graph when human attention matters.
</p>

<p align="center">
  <strong>Skill-first</strong> · <strong>Git-native</strong> · <strong>Local by default</strong> · <strong>No runtime service</strong>
</p>

![VibeHub local Ticket graph](docs/assets/local-graph/quiet-workbench-desktop.jpg)

## One development cycle, two kinds of truth

| | Ticket | Context |
| --- | --- | --- |
| **Answers** | What must change, what unlocks next, and how success is proven? | What decision, constraint, or intent must survive this task? |
| **Created when** | There is an executable deliverable. | The user explicitly asks to record something, or work reveals a real cross-Ticket fact. |
| **Lives in** | `.vibehub/tickets/`, with Evidence and an independent Outcome. | `.vibehub/context/`, with source and provenance. |

Tickets drive development. Context protects meaning. VibeHub does not turn every
conversation into memory or every note into work.

## The workflow presents itself

You should not need to remember a UI command. The Ticket Skills own one compact
lifecycle and present the focused graph at the moments where seeing it helps:

| Moment | What you see | What happens next |
| --- | --- | --- |
| **Plan** | **Execution** — the new Ticket, its contract, and direct dependency path | Work continues |
| **Run** | Nothing extra | The Agent executes quietly from checked-in truth |
| **Human boundary** | **Contract** — the exact choice or acceptance that needs you | Work waits for your decision |
| **Closeout** | **Log** — Evidence, Outcome, and what became executable | The result is reported |
| **PR / explicit review** | The current graph | You audit the branch when you want to |

A Ticket is not complete because its executor says so. The executor records
acceptance-linked Evidence; an independent Agent writes the Outcome. Only a
successful Outcome unlocks direct dependents.

## Start a cycle

Install the plugin through your Codex or Claude Code plugin flow, then ask:

> Set up VibeHub for this repository.

Setup detects existing docs, memory folders, project Skills, and similarly
named capture commands before writing. When another memory system overlaps,
you choose **dual-write** or **VibeHub-only**. See [installation and coexistence](docs/INSTALL.md).

Then describe a deliverable naturally:

> Start this as a VibeHub Ticket and build it.

The Agent plans the smallest honest Ticket graph, validates it, executes one
READY Ticket, records Evidence, and hands closeout to an independent Agent.
Git remains responsible for branches, rollback, merge conflicts, and review.

When you say “record this”, “remember this”, or “沉淀一下”, VibeHub normally
captures Context—not a Ticket. If the same conversation also creates work, it
writes one Context item and a Ticket that references it.

## A graph made for decisions

The local graph answers one question first: **what can execute next?** It keeps
direct unlocks, forks, joins, deviations, Evidence, and Outcomes available
without flattening them into a wall of text. Selecting a Ticket moves from a
three-second orientation to its Contract, Execution, and Log without changing
the underlying truth.

The graph is read-only. Every refresh projects the exact checkout's checked-in
files; copy-for-Agent and source links hand work back to the tools that already
own editing. To open it explicitly as a fallback:

```bash
node <plugin>/skills/scripts/vh-ui.mjs --repo <repository>
```

The narrow launcher starts an ephemeral loopback server, opens a short-lived
authorized URL in the normal browser, and exits with the foreground process.
There is no database, daemon, persistent cache, or write endpoint. See the
[local graph design authority](docs/LOCAL_GRAPH_DESIGN.md).

## The entire durable model

```text
.vibehub/
  context/<context-id>.yaml
  tickets/<ticket-id>.yaml
  evidence/<ticket-id>/<evidence-id>.yaml
  outcomes/<ticket-id>.yaml
```

These are deterministic, JSON-compatible YAML 1.2 documents. Agents make the
semantic decisions; small dependency-free scripts validate the shared schemas
and project the graph. Consumers never own a second durable model.

VibeHub intentionally ships without a required Core package, global CLI, MCP
server, SQLite database, native module, hook cadence, lease, or background
capture. If real use exposes a missing capability, it can be rebuilt from the
observed gap instead of being carried as speculative infrastructure.

## Verify locally

Requirements: Node.js 20+ and Git. No dependency install or native build is
required.

```bash
npm run verify
```

VibeHub releases are plugin archives published through GitHub Releases. npm is
not a distribution surface for the Skill-first product.

## License

Apache-2.0
