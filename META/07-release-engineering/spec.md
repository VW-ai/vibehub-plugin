# 07-release-engineering — Release Engineering

The source repository is not itself the install artifact. Releases build
self-contained Claude and Codex marketplaces containing the shared CLI, MCP,
skills, hooks and native SQLite dependency.

## Required gates

1. Build and typecheck the workspace.
2. Build self-contained Claude and Codex artifacts within file/size budgets.
3. Install each marketplace in an isolated host home using the real host CLI.
4. Execute hooks, MCP, setup and SQLite from the installed copy, never the source
   checkout.
5. For Codex, prove the installed MCP reaches `ready` in the real app-server.
6. Keep both plugin manifests and marketplace entries on one name/version.
7. Scan the full rewritten history before publishing.
8. Verify install and activation from a fresh public clone.

The public beta may honestly describe the Browser App as experimental. It must
not claim lifecycle events that a host does not expose.

## Canonical Specs

- [constraint-release-engineering-001] (active) Both real hosts must consume
  isolated installed artifacts.
- [change-2026-07-18-codex-activation-parity] (active) Thin native Codex adapter
  and real host verification.
- [change-2026-07-19-claude-marketplace] (active) Self-contained Claude
  marketplace and installed-runtime verification.
- [constraint-public-beta-001] (active) The first public beta is honestly
  source-built until a versioned hosted marketplace is published.
- [change-2026-07-19-plugin-repository-migration] (active) Standalone history,
  plugin-centric META and public repository identity migration.
