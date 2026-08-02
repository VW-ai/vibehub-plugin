# VibeHub

VibeHub is a lightweight plugin for Ticket-driven development with durable,
Git-native project Context.

## Current phase: dogfood

The architecture pivot is complete. This version is now in a dogfood-only
validation phase: use it for real development, observe where it helps or
fails, and do not pre-emptively rebuild deleted layers or pursue a runtime
parity checklist.

For each real deliverable, start with a Ticket, develop against its acceptance
criteria, record acceptance-linked Evidence, and let an independent Agent write
the Outcome. Capture durable decisions as Context only when explicitly asked
or when the Ticket exposes a fact that must survive across work. When real use
reveals friction or a missing capability, open a focused Ticket with the
observed failure and desired outcome; that evidence, not speculation, is the
reason to extend the product.

The product has two layers:

- **Tickets drive development.** A deliverable becomes a checked-in Ticket with
  outcome, acceptance, constraints, Context references, and direct dependencies.
- **Context preserves durable meaning.** Decisions, intent, constraints,
  contracts, conventions, and reusable explanations are captured only when the
  user explicitly asks or a Ticket workflow identifies a real cross-Ticket fact.

VibeHub is Skills plus files. It does not require a global CLI, MCP server,
SQLite database, native module, daemon, hook cadence, Run lease, Context copy,
or writable local host. Agents use their normal file and Git tools; small
bundled scripts only validate and serialize the shared schemas.

## What happens when the user says “record this”?

“帮我记录一下”, “沉淀一下”, and “remember this” normally create Context, not a
Ticket. A Ticket is created when there is an executable deliverable.

If one conversation contains both a durable decision and work to implement it,
VibeHub writes one Context item plus one Ticket that references it. It does not
turn every note into work or every work item into permanent knowledge.

## Development cycle

1. `$vibehub-ticket-plan` creates the smallest honest Ticket graph.
2. An independent Agent uses `$vibehub-ticket-validate` when available.
3. `$vibehub-ticket-run` executes one READY Ticket from checked-in context.
4. The executor records acceptance-linked Evidence.
5. An independent `$vibehub-ticket-closeout` writes a successful, partial,
   failed, or deviated Outcome. Only success unlocks direct dependents.

Git owns branch isolation, history, rollback, merge conflicts, and PR review.
VibeHub assumes one Agent/writer per worktree and does not rebuild Git's
concurrency model.

## Local graph UI

Ask the Agent to open the VibeHub Ticket graph, or run the bundled launcher:

```bash
node <plugin>/skills/scripts/vh-ui.mjs --repo <repository>
```

The established directed-graph experience includes Ticket state, direct
dependency edges, pan/zoom, fit, minimap navigation, causal highlighting, and
an inspector for Context references, acceptance, Evidence, and Outcome. Each
refresh projects the exact checkout's `.vibehub/` files directly.

The launcher is a narrow, dependency-free foreground process: ephemeral
loopback port, short-lived bearer URL, restrictive browser headers, and no
database, daemon, persistent cache, or write endpoint. Browser writes and
Decision authority are deliberately outside this first restored UI slice.

By default the launcher opens the complete authorized URL in your normal
system browser. The page keeps that short-lived `#` fragment in the address bar
and provides **Copy link**, so the same URL can be pasted into another local
browser while the foreground launcher is running. Use `--no-open` only when an
Agent or test should print the URL without opening a browser.

## Data

```text
.vibehub/
  context/<context-id>.yaml
  tickets/<ticket-id>.yaml
  evidence/<ticket-id>/<evidence-id>.yaml
  outcomes/<ticket-id>.yaml
```

The files use a JSON-compatible YAML 1.2 subset. That keeps them readable,
deterministic, dependency-free, and validatable in a clean plugin install.
Schemas live in `skills/contracts/`.

```text
Agent / Skills -> canonical documents -> shared validation -> UI / helper / Cloud
```

This is the product boundary. Agents make semantic decisions and write the four
canonical document types; downstream surfaces only validate, read, and project
them. Invalid files fail before projection instead of being guessed into shape.
Selection, graph layout, pan, and zoom may remain disposable UI memory, but no
consumer owns a parallel durable model or a second source of truth.

There is no persistent digest cache. A future UI may keep a disposable
in-process render cache if profiling proves it useful; that cache would never
be truth, authority, currentness, or completion state.

## Install and setup

Install the plugin through your Claude Code or Codex plugin flow, then ask:

> Set up VibeHub for this repository.

`$vibehub-setup` first detects existing documentation, memory folders, project
skills, and similarly named capture commands. If another memory system may
overlap, it asks you to choose dual-write or VibeHub-only before changing the
repository. See [docs/INSTALL.md](docs/INSTALL.md).

## Local verification

Requirements: Node.js 20+ and Git.

```bash
npm test
npm run verify:artifact
```

No dependency install or native build is required.

## License

Apache-2.0
