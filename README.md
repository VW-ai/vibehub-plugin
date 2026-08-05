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

![VibeHub local Ticket graph](docs/assets/local-graph/quiet-workbench-desktop.jpg)

That one line is the entire user entry. Describe the work, say it, and the
Agent handles repository setup when needed, plans the smallest honest Ticket,
executes it, records Evidence, asks for human attention only at a real boundary,
and hands completion to an independent Outcome.

Tickets, durable Context, Evidence, and Outcomes remain ordinary Git files.
The graph appears when it helps you orient, decide, or audit; routine execution
stays out of the way.

## Installation

**Codex**

```bash
codex plugin marketplace add VW-ai/vibehub-plugin
codex
```

Then open `/plugins`, install **VibeHub** from the `vibehub` marketplace, and
start a new session.

**Claude Code**

```text
/plugin marketplace add VW-ai/vibehub-plugin
/plugin install vibehub@vibehub
/reload-plugins
```

Describe the work in a new session, then use the single entry above.

## Upgrades

The host updates the plugin bundle; VibeHub never updates itself in the
background and never rewrites checked-in project data during installation.
Claude Code can refresh auto-update-enabled marketplaces and apply the new
bundle with `/reload-plugins`. In Codex, refresh the Git marketplace with
`codex plugin marketplace upgrade vibehub`, refresh or reinstall the plugin,
then start a new session. If `.vibehub/version.yaml` needs migration, the new
session previews and applies that change separately through the migrate Skill.
Read the [product concept](docs/CONCEPT.md), [installation and coexistence](docs/INSTALL.md),
[local graph design](docs/LOCAL_GRAPH_DESIGN.md), or [release procedure](docs/RELEASE.md).
Apache-2.0
