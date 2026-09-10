# VibeHub Architecture Boundary

VibeHub is Skills plus local YAML records, with explicit opt-in to Git sharing. The product
ships no general-purpose or globally installed CLI, MCP server, database,
daemon, hook cadence, native runtime, background capture,
or hidden state. Git can own shared history, concurrency, rollback, and
review; GitHub is optional and disabled by default. Deterministic validation and migration live in bundled
dependency-free scripts; semantic judgment lives in Skills.

One narrow exception is the explicitly invoked `vibehub-upgrade` one-shot
entry shipped as a dependency-free npm-layout tarball on the same GitHub
Release as the Skill artifact. It may run outside one project and
may only: accept bounded discovery roots; identify Git repositories beneath
those roots; enumerate their registered existing worktrees; invoke the
shared migration engine and migration reference separately for each safe
worktree; create one local reviewable migration commit per successfully
migrated worktree; and report every no-op, success, unsupported state, or
pending reason. Discovering one repository authorizes traversal only to the
worktrees registered by that same repository, including a registered sibling
whose path lies outside the discovery root; it never authorizes another
filesystem scan.

The upgrade entry owns no migration semantics and no durable project index.
No Skill depends on it for ordinary project work. Nothing invokes it in the
background, at install time, or from a hook, daemon, service, scheduled job,
or UI. It must not add compatibility shims, telemetry, network reporting,
authoritative state outside Git, automatic stash or reset behavior, or any
push operation. All remaining semantic migration stays in a later Agent
session in the affected worktree. Anything beyond this boundary is a defect,
not a feature.

## Unified dashboard

A foreground loopback dashboard starts automatically when a user chooses or
resumes VibeHub. The entry helper reuses a known live session URL without
reopening the browser, and startup failure never blocks work. It enumerates
the current checkout and Git projects under user-supplied roots and their registered worktrees. It may read an explicitly
selected personal-ticket store to show goals and tasks alongside those projects.
It keeps no durable project registry, starts no agents, and writes no ticket data.
Users can browse repositories without initializing VibeHub. Record validation
affects the selected record view only; one invalid checkout cannot block the home
or other projects. The existing authenticated Workbench remains the per-checkout
contract and evidence inspector. VibeHub never dictates model response formats
or requires users to adopt its Ticket lifecycle for ordinary work.
