# Changelog

## 0.7.0 — 2026-08-11

- Rebuild the shared dependency-free Ticket graph as the responsive A · Quiet
  Workbench surface, with top-to-bottom causal flow, progressive
  Execution/Contract/Log inspection, an honest empty Active-Run presence layer,
  and persistent exact Git source visibility.
- Preserve v0.6.0's per-acceptance human authority, human-attention projection,
  human-origin Evidence, explicit maturity/REFINE behavior, and READY-only
  stateless Agent handoff throughout the Web UI conflict resolution.
- Keep the release UI-only: the proposed macOS Desktop shell, custom deep
  links, repository switching, foreground launcher, session watcher, and
  Desktop packaging do not enter the shipped plugin.
- Preserve PR #18's original Ticket, Evidence, and Outcome ledger byte-for-byte
  in a non-canonical history snapshot while appending the later UI-only product
  decision and delivery records to the active graph.
- Disable repository-configured `core.fsmonitor` on every retained UI-host Git
  subprocess, with a malicious-hook regression proving that opening an
  untrusted repository cannot execute its configured fsmonitor command.

## 0.6.0 — 2026-08-10

- Add per-acceptance decision authority: each criterion may name `agent` or
  `human` as its decision owner while existing Tickets remain compatible with
  Agent authority as the default.
- Enforce human-origin Evidence for human-owned criteria before an independent
  closeout may accept them, without introducing an approval or identity
  service.
- Project human-attention states mechanically in the Workbench, distinguishing
  upcoming decisions, pending human Evidence, recorded Evidence, and completed
  Outcomes without changing READY, BLOCKED, REFINE, DONE, or DEVIATED.
- Make `maturity: firm` and `maturity: draft` explicit, symmetric planning
  values; legacy omission remains firm, while unblocked draft work surfaces as
  REFINE until Ticket Plan firms the same Ticket in place.
- Define a stateless repository-level Agent handoff: any current or later Agent
  can continue from the checked-in Ticket, decision Outcome, and Evidence,
  without assigning, waking, or binding an Agent session.
- Model real scheduling boundaries as a causal graph of firm proposal → firm
  human decision → draft downstream refinement, so a successful decision moves
  dependent work to REFINE rather than pretending its acceptance was known.

## 0.5.0 — 2026-08-04

- Introduce the Room taxonomy: every Context entry lives in the room that
  owns it under `.vibehub/rooms/`, directories carry containment, and the
  flat `.vibehub/context/` is removed (a populated legacy directory fails
  validation with migration guidance).
- Add the deterministic freshness layer: `vh room drift`, `align`, and
  `stale` compare snapshot blob hashes as ground truth, with anchor-overlap
  detection and stale-origin layering (`drift:` marks are recomputable,
  unprefixed marks are preserved claims).
- Restore distillation as two ambient modes: a resumable cold start that
  builds the Room tree and align-on-use updates at every Ticket start.
- Complete the Ticket lifecycle: mid-execution work discovery and rolling-wave
  draft Tickets (`maturity: draft` surfaces as REFINE and never executes),
  both as plan-owned lifecycle events.
- Contractize the skill system: knowledge-governance and architecture-boundary
  shared references, plus a model-free contract test layer welding every
  skill-cited command and pointer to reality.
- Make vibehub-pr room-aware: merge semantics for Rooms, a drift gate before
  PR handoff, and a Room-lens summary.
- Ship agent-driven upgrades: `vibehub-migrate` restructures a 0.4-style
  project into the Room world from a versioned migrations reference; the
  data layer carries no forward-compatibility shims.

## 0.4.0 — 2026-08-02

- Pivot VibeHub to a lightweight Skill-first plugin with direct Git-native
  Context, Tickets, Evidence, and Outcomes.
- Remove the required Core/CLI/MCP packages, SQLite/native runtime, hooks,
  dispatcher, coordination/attestation stack, and old writable review host.
- Add dependency-free schemas, validation, fresh-process Context roundtrips,
  Ticket graph checks, and direct dependent unlock semantics.
- Restore the comprehensive local Ticket graph as a dependency-free read-only
  loopback UI that projects the checked-in YAML directly, without reviving the
  old CLI/runtime stack.
- Replace the nested popover-style graph shell with a full-window VibeHub
  workbench and preserve the short-lived authorized URL so it can be copied
  into the user's normal browser.
- Present the focused Execution, Contract, Log, or graph surface automatically
  at lifecycle moments where human attention matters while routine execution
  stays quiet.
- Publish the Skill-first plugin as a versioned GitHub Release artifact with a
  checksum. npm is no longer a VibeHub distribution surface.
- Collapse the public product surface to one canonical entry—`Start this with
  VibeHub.`—and add a dark-mode-safe wordmark for GitHub.

**Breaking:** v0.4.0 deliberately removes the v0.3 Core/CLI/MCP runtime and its
npm-backed installation path. Existing `.vibehub/` Context and Ticket documents
remain ordinary Git files.

All notable VibeHub changes are recorded here. Versions follow Semantic
Versioning.

## 0.3.0

- Added one authenticated, idempotent private-release installer for Claude Code
  and OpenAI Codex through `vibehub host install`.
- Extended release verification so the complete host install and public npm
  runtime run on every certified macOS/Linux architecture, including a real
  Codex MCP startup.
- Bounded first-use npm runtime installation so a restricted network cannot
  leave a host process waiting indefinitely.
- Made release publication content-bound and rerun-safe: npm artifacts must
  match the tag build, and a published GitHub Release is never overwritten.

## 0.2.2

- Made npm release restarts compare normalized tar payloads, so identical
  package contents built on different hosts are safely recognized even when
  their gzip wrapper bytes differ.
- Verified that the product-qualified packages publish through GitHub Actions
  OIDC without an npm token or interactive browser authentication.

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
