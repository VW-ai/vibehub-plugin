# OpenAI Codex host procedure

Codex onboards the same project through the same deterministic receipts.
Target the exact checkout and run the identical `setup inspect`,
`setup apply`, and `setup status` commands with `--repo`; parse the same
`ProjectActivationResultV1` evidence. One shared database (default
`~/.vibehub/workbench.db`, or `VIBEHUB_DB`), one repository identity (the
Git common root), the same worktree binding, and the same operation
receipts. Never create a Codex-specific database, a second instruction
vocabulary, or a second state language.

The managed block that setup owns in `AGENTS.md` is the Codex-facing
project instruction. Codex builds its instruction chain from the checkout's
`AGENTS.md` at session start, so after a changeful apply start a fresh
Codex session in the exact checkout that was inspected and applied.

## Machine prerequisites (verify only; never install here)

1. The CLI must be reachable through an explicit user-supplied path,
   `VIBEHUB_BIN`, or as `vibehub` on PATH. `CLAUDE_PLUGIN_ROOT` does not
   exist on Codex; do not depend on it.
2. The six packaged vibehub skills must be present in the host's skills
   location together with their sibling shared resource directories exactly
   as packaged. Common locations include the repository or home
   `.agents/skills` directory; some builds use the skills directory under
   the Codex home. Follow the host's own documentation.
3. The VibeHub MCP stdio server should be registered in the host MCP
   configuration — for current Codex releases an `[mcp_servers.vibehub]`
   entry in the Codex `config.toml`, running `node` with the absolute path
   to the packaged MCP stdio entrypoint under the deployed plugin root (the
   same entrypoint the packaged `.mcp.json` declares). Follow the host's
   own documentation for exact registration syntax and trust approval.
4. The session must be permitted to execute the CLI. If any prerequisite is
   missing, stop and report it; machine onboarding is a user action.

## Evidence interpretation on Codex

Installed can be proven from Codex alone: it is host-independent. Connected
requires a host lifecycle-hook session recorded after the current
instruction blocks for the exact checkout, and this release packages and
validates hook ingestion for Claude Code only. Therefore `setup status`
reporting `waiting` with connected and activated `not_proven`
is the expected, correct, honest result in a Codex-only environment. That
state is waiting, not failure, and must never be "fixed".

Both hosts share one database and one activation state per repository. If
Claude Code proves the handshake for this checkout, later qualifying
context-value receipts advance Activated regardless of which host produced
them. Never stage a Claude session or replay recorded hook events to
simulate that path.

## Host capability matrix (this release)

Available on Codex now:

- project instructions through the managed `AGENTS.md` block;
- the six packaged workflow skills;
- the MCP capabilities (`register_scope`, `self_report`, `kb_retrieve`,
  `kb_operation`, `distill_operation`, `get_manual`);
- the full CLI, including setup and knowledge/distillation operations with
  real receipts.

Not available on Codex in this release (one honest cluster — no hook
fires):

- hook session capture, so no host handshake and no Connected or Activated
  proof from Codex alone;
- injection and pause delivery at hook boundaries;
- off-scope reminders;
- the periodic knowledge checkpoint reminder;
- automatic task state transitions — Codex-driven tasks appear at the
  basic signal tier.

Current Codex releases document their own lifecycle hooks, but VibeHub has
not validated their payload mapping, output protocol, or session
attribution, so they are not evidence in this release. The compensating
discipline: the managed instruction block plus the skills already teach
querying context before non-trivial work and capturing durable knowledge
at decision time.

## Forbidden on Codex

- Do not tail host logs, watch files, poll for activity, or bridge events
  to imitate hook capture.
- Do not wire the hook CLI into Codex hook configuration in this release —
  unvalidated payloads would create false handshake evidence attributed to
  the wrong host.
- Do not write sessions or receipts by hand, edit managed markers, or
  present `not_proven` as proven.
- When a capability is missing, say so; honest degradation is the
  contract.
