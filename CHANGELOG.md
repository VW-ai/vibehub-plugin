# Changelog

All notable VibeHub changes are recorded here. Versions follow Semantic
Versioning.

## 0.2.1

- Renamed the public npm packages to `@vw-ai/vibehub-core`,
  `@vw-ai/vibehub-cli`, and `@vw-ai/vibehub-workbench-mcp` so the shared
  `@vw-ai` organization can publish multiple products without ambiguous
  package names.

## 0.2.0

- Added the first public npm packages for the core runtime, CLI, and MCP
  server. Their short-lived names were superseded by the product-qualified
  names in 0.2.1.
- Added tokenless npm publishing from GitHub Actions through npm Trusted
  Publishing (OIDC), with automatic provenance.
- Bundled the MCP stdio runtime so unused HTTP adapter dependencies do not
  enter the consumer installation tree.
- Started the transition from platform-specific marketplace branches to a
  thin, platform-neutral marketplace plugin backed by npm packages.

## 0.1.1

- Added Git-backed semantic checkpoints and the packaged `vibehub-pr`
  workflow for receipt-bound semantic commits and pull-request preparation.
- Kept the public release line headless by moving unfinished Workbench UI
  development off `main` and removing React, Vite, and Playwright from the
  release workspace and gates.
- Preserved the shared CLI, MCP, skills, hooks, and Claude/Codex marketplace
  artifact while validating direct runtime reads in headless dogfood.

## 0.1.0

- Added the local-first SQLite context runtime, CLI, MCP server, lifecycle
  hooks, and six shared workflow skills.
- Added native Claude Code and OpenAI Codex plugin packages.
- Added self-contained local marketplace builders and isolated real-host
  installation verification.
- Added public Node 24 marketplace release channels for macOS and Linux on
  arm64 and x64, with immutable rollback branches, GitHub Release archives,
  provenance, and SHA-256 checksums.
- Added the VibeHub territory mark and wordmark to the repository README and
  self-contained marketplace artifacts.
