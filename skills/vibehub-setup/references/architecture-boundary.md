# VibeHub Architecture Boundary

VibeHub is Skills plus checked-in Git-native YAML documents. The product
ships no general-purpose or globally installed CLI, MCP server, database,
daemon, hook cadence, native runtime, local web service, background capture,
or hidden state. Git and GitHub own history, concurrency, rollback, and
review. Deterministic validation and migration live in bundled
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
