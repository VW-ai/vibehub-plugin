# VibeHub Workbench

VibeHub is a local-first context runtime for coding agents. The Claude Code
plugin, hooks, skills, MCP server, CLI, and SQLite database form a complete
headless product. The browser workbench is an optional reader and intervention
client: closing it never stops capture, retrieval, or delivery.

SQLite is the only source of truth. JSON or Markdown output is an export for
people and tools, not a fallback database.

## Requirements

- Node.js 20 or newer
- pnpm 10.8.1
- Git
- Claude Code for the plugin integration

## Install from source

```bash
pnpm install --frozen-lockfile
pnpm build
```

Initialize a repository and verify the local runtime:

```bash
node packages/cli/dist/main.js init --repo /path/to/repository
node packages/cli/dist/main.js doctor --repo /path/to/repository --json
```

`init` owns VibeHub's SQLite schema and managed plugin assets. It does not
silently replace user-owned Claude configuration. Re-running it is safe; use
`doctor --json` for machine-readable health and repair guidance.

Install this directory as a Claude Code plugin using Claude's local plugin
workflow. The plugin manifest is `.claude-plugin/plugin.json`; hooks, MCP, and
the `vibehub-ingest`, `vibehub-distill`, and `vibehub-query` skills ship with
the same directory.

## Headless operation

The CLI and MCP server call the same deterministic core. No API key or LLM is
required by either executable.

```bash
# Refresh git/team facts in SQLite.
node packages/cli/dist/main.js team sync --repo /path/to/repository --json

# Inspect the runtime's current map without opening the app.
node packages/cli/dist/main.js snapshot --repo /path/to/repository
node packages/cli/dist/main.js inspect --repo /path/to/repository

# Write an explicit disposable export.
node packages/cli/dist/main.js snapshot \
  --repo /path/to/repository \
  --out /tmp/vibehub-snapshot.json
```

`team snapshot` remains a compatibility alias for existing integrations.

Agent knowledge creation, distillation, and querying are owned by the three
skills. Hooks decide when to remind the agent; MCP capabilities validate and
persist deterministic operations. Workflow intelligence does not live in hook
descriptions or the CLI.

### MCP v0.2 operation surface

The advertised tools are `register_scope`, `self_report`, `kb_retrieve`,
`kb_operation`, `distill_operation`, and `get_manual`. `kb_operation` and
`distill_operation` are thin adapters over the same versioned operations used
by the CLI; use `vibehub-ingest` and `vibehub-distill` for semantic workflow.

MCP v0.2 removes the legacy `kb_record` and `kb_apply_distillation` names.
Neither legacy tool could honestly satisfy the current evidence-backed,
versioned persistence contracts. Clients must route canonical KB writes
through `kb_operation` and distillation runs through `distill_operation` (or
the equivalent `vibehub kb` / `vibehub distill` CLI commands).

Repository request IDs bind operation plus canonical actor, task (or null), and
input; timestamps are deliberately excluded. Once `repoId` and `requestId` are
syntactically usable, success, typed handler failure, input-validation failure,
and unsupported-operation failure all reserve and replay that identity.
Context failures without both a positive repository ID and canonical request
ID cannot address a receipt and therefore remain unreceipted.

For MCP operation adapters, `requestId` is an optional top-level tool argument,
separate from operation `input`. Supply it only when the caller needs stable
logical replay; otherwise the capability generates a collision-resistant UUID.
MCP transport correlation IDs are never persisted as repository request IDs.

## Optional workbench UI

The current app host is for local development and dogfood. It is not a native
downloadable build yet. Point it at one explicit repository; it reads the same
SQLite runtime through the browser-safe bridge and never substitutes fixtures
when the runtime is unavailable.

```bash
VIBEHUB_REPO=/path/to/repository pnpm --filter @vibehub/workbench-app dev
```

## Verification

```bash
# Build, typecheck, unit tests, production bundle scan, and plugin artifact smoke.
pnpm verify

# Copy only workbench/ to a temporary directory, install from its own lockfile,
# then run the full gate there. This is the subtree/repository split gate.
pnpm verify:isolated

# Exercise init, hooks, MCP context CRU, snapshot/App bridge, and Stop delivery
# against an isolated temporary Git repository and SQLite state.
pnpm dogfood
```

The production bundle gate rejects fixture imports—including dynamic chunks—and
scans emitted JavaScript for fixture or canned-data markers. The artifact smoke
deploys CLI and MCP production dependencies, starts from a clean temporary
`HOME`, creates SQLite through the packaged native dependency, and runs sync and
snapshot outside the source monorepo.

Set `VIBEHUB_KEEP_TMP=1` to retain a failed isolated copy or artifact for
inspection. Set `VIBEHUB_OFFLINE=1` only when all required package tarballs are
already available in the pnpm store.

## Repository boundary

Everything required by the future public repository lives under this directory.
Code here must not import server-side VibeHub packages. Until dogfood validates
the boundary, development remains in the monorepo and preserves history for a
later `git subtree split`.

## License

Apache-2.0. See [LICENSE](LICENSE).
