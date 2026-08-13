<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/vibehub-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/vibehub-logo.svg">
    <img src="assets/brand/vibehub-logo.svg" alt="VibeHub" width="360">
  </picture>
</p>

<p align="center"><strong>VibeHub turns a development request into a Git-native Ticket cycle your coding agent can plan, execute, prove, and close.</strong></p>

<h3 align="center"><code>Start this with VibeHub.</code></h3>

<p align="center"><em>Memory tools preserve the conversation; VibeHub preserves the development cycle.</em></p>

![VibeHub v0.8 canvas-first Ticket Workbench](docs/assets/local-graph/quiet-workbench-desktop.jpg)

Describe the work and say that one line. VibeHub plans the smallest honest
Git-native Tickets and keeps current causal work on the canvas. Select a Ticket
for Execution, Contract, and Log detail; open Rooms or history only when useful;
and follow clear signals when a decision genuinely needs you.

As work proceeds, the Agent records acceptance-linked Evidence and hands
completion to an independent Outcome. Tickets, durable Context, Evidence, and
Outcomes remain ordinary Git files, so the next Agent can resume from exact
repository truth while routine execution stays out of the way.

## Installation

**Codex**

```bash
codex plugin marketplace add VW-ai/vibehub-plugin
codex plugin add vibehub@vibehub
```

Then start a new task and use the single entry above.

**Claude Code**

```text
/plugin marketplace add VW-ai/vibehub-plugin
/plugin install vibehub@vibehub
/reload-plugins
```

## Upgrades

The host updates the plugin bundle; VibeHub never updates itself in the
background and never rewrites checked-in project data during installation.
In Codex, run `codex plugin marketplace upgrade vibehub` followed by
`codex plugin add vibehub@vibehub`, then start a new task. In Claude Code, run
`claude plugin update vibehub@vibehub --scope user`, then restart Claude Code
(or use `/reload-plugins` after a marketplace refresh). If project data needs
migration, the new session previews that separate Git change through the
migrate Skill; installing a plugin never rewrites `.vibehub/`.
Read the [product concept](docs/CONCEPT.md), [installation and coexistence](docs/INSTALL.md),
[local graph design](docs/LOCAL_GRAPH_DESIGN.md), or [release procedure](docs/RELEASE.md).
Apache-2.0
