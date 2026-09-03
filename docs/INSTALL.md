# Install VibeHub

VibeHub is a Skill-first plugin. Installation copies manifests, Skills,
schemas, dependency-free helper scripts, and the local graph UI assets. It does
not install a global CLI, MCP server, hook process, database, native module, or
daemon. The read-only UI host starts in the foreground when a Ticket lifecycle
moment needs a visual review, or when explicitly requested as a fallback, and
exits with its launcher process.

## Install

**Any skills-capable agent (recommended).** One command installs every
VibeHub Skill into the agent directories it detects (`.claude/skills/`,
`.agents/skills/`, …) through [skills.sh](https://skills.sh):

```bash
npx skills add VW-ai/vibehub-plugin
```

Choose **Select all** in the picker. The shared helper and contracts ship
inside the `vibehub-core` skill folder; a partial install that omits
`vibehub-core` leaves the other Skills without `../vibehub-core/scripts/vh.mjs`
— each Skill detects that and tells the Agent to run
`npx skills add VW-ai/vibehub-plugin -s vibehub-core`.
`vibehub-core` is infrastructure, not a workflow — nothing in it is invoked
directly.

There is no second install path. Host marketplace distribution was retired:
it delivered the whole development repository rather than the Skills, and its
version-string cache key let an install go stale in silence. If you installed
VibeHub through a Claude Code or Codex marketplace, remove it there and run the
command above instead.

## Requirements

- Claude Code or Codex with plugin/Skill support
- Node.js 20+ for bundled validation scripts
- Git for history, collaboration, and rollback

## Start in a repository

Describe the concrete deliverable, then tell the Agent:

> Start this with VibeHub.

Ticket Plan owns this entry. When the exact checkout has not been initialized,
it uses VibeHub Setup first and then resumes the same development cycle. The
user does not need to choose a Skill or issue another command.

Before writing, setup inspects common overlapping surfaces:

- `AGENTS.md` and `CLAUDE.md`
- `docs/` and repository knowledge folders
- `.github/copilot-instructions.md`
- project-local Claude/Codex skills
- existing memory, context, decision, ADR, or note systems
- similarly named “record”, “remember”, or archive commands

When overlap exists, setup asks for one choice:

- **dual-write** — keep the current system and update its command to write both
  stores; or
- **VibeHub-only** — stop old writes after an explicitly reviewed one-time
  conversion.

If the user does not grant write permission, VibeHub can still read and advise,
but cannot claim a complete development cycle.

After consent, setup creates only:

```text
.vibehub/version.yaml
.vibehub/rooms/
.vibehub/tickets/
.vibehub/evidence/
.vibehub/outcomes/
```

and a small managed project-instruction block. Validate with:

```bash
node <plugin>/skills/vibehub-core/scripts/vh.mjs project validate --repo <repository>
```

Setup then asks one optional question when the repository's `origin` is on
GitHub: whether to mirror Tickets to GitHub Issues. Saying yes copies one
workflow and a self-contained `scripts/vibehub/` folder (the sync script, the
helper, and two contract files) so the mirror runs in GitHub Actions on push
to `main` without the plugin; no Agent ever runs or checks it. See
[GITHUB_ISSUES.md](GITHUB_ISSUES.md).

## Upgrade the plugin and project data

Plugin code and checked-in project data have separate lifecycles. Updating a
plugin bundle never writes `.vibehub/`. The installed helper first reports the
repository compatibility state:

```bash
node <plugin>/skills/vibehub-core/scripts/vh.mjs project compatibility --repo <repository>
```

`CURRENT` permits normal work. `MIGRATION_REQUIRED` routes through
`$vibehub-migrate`, which previews the affected Git paths and waits at the
explicit migration boundary before restructuring them. `UNSUPPORTED_NEWER`
means the repository needs a newer plugin; VibeHub does not guess or downgrade
the data.

For a release upgrade, choose one immutable release tag and repeat it in both
commands (replace `<host>` with `codex`, `claude-code`, or another skills.sh
host, and replace the roots with directories you explicitly want scanned):

```bash
npx skills add https://github.com/VW-ai/vibehub-plugin/tree/<release-tag> -a <host> -s '*' -y
npx --yes https://github.com/VW-ai/vibehub-plugin/releases/download/<release-tag>/vibehub-upgrade.tgz \
  --root <bounded-root> [--root <another-root>]
```

Do not pair `npx skills update` with a floating `releases/latest` upgrader:
the default branch and latest published Release may be different revisions.
The one-shot upgrader verifies and prints its embedded tag, commit, engine,
contracts, and migration registry before discovery. It follows no symlinks,
scans only below the explicit roots, then includes only the registered
worktrees of repositories found there. A safe worktree is mechanically
migrated and receives one local reviewable commit. Dirty, detached, missing,
unsupported, semantic-first, or otherwise unsafe worktrees are unchanged and
reported with an exact reason. Nothing is pushed. Open a later Agent session
inside each worktree that reports semantic-pending refs to complete only that
guided semantic work.

**Claude Code.** Run `/reload-plugins` after an update when you want the new
Skills in the current process, then start or resume work.

**Codex.** Start a new session after an update. Codex does not currently
expose a documented Skill hot-reload, so VibeHub does not claim or emulate one
with a daemon or hook.

## Ticket graph presentation

Ticket Skills proactively present the focused graph after planning, at a
protected human boundary, after closeout, and for PR review. Routine execution
stays quiet. To open the graph explicitly as a fallback, ask the Agent to use
`$vibehub-ticket-review` or launch the bundled helper:

```bash
node <plugin>/skills/vibehub-core/scripts/vh-ui.mjs --repo <repository>
```

The default command opens the complete short-lived URL in your normal system
browser. Use the page's **Copy link** control to open that same authorized URL
in another local browser. Keep the `#...` fragment: a bare loopback origin is
intentionally unauthorized. Use `--no-open` only to print the URL for an Agent
or test, `--port <port>` to choose a loopback port, and `--json` for an
Agent-readable launch envelope. The UI reads the repository's checked-in YAML
directly, rejects invalid canonical documents before projection, and exposes
no write routes. Its visual and interaction contract is documented in
[LOCAL_GRAPH_DESIGN.md](LOCAL_GRAPH_DESIGN.md).

## Uninstall

Remove the plugin through the host. Repository Context and Tickets remain
ordinary Git files. Delete them only when you intentionally want to remove the
project history; Git can restore earlier versions.
