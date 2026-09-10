# Install VibeHub

VibeHub is Skill-first. `npx skills add` copies the Skill directories, including
their bundled schemas, dependency-free helper scripts, and local graph UI
assets. It does not copy a marketplace bundle or install a global CLI, MCP
server, hook process, database, native module, or daemon. The built-in dashboard starts automatically when a user chooses or resumes
VibeHub. Its foreground host is reused within the current agent session and
exits with its launcher process. It is not a separate app the user must start.

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

The source repository retains `.claude-plugin/plugin.json` only because
skills.sh reads it as repository metadata and the release checker uses its
version as an identity anchor. It is not installed as a marketplace. The
marketplace manifest and the retired Codex plugin manifest were removed with
their builders and tests.

**Updating across a Skill rename.** `npx skills add` copies Skill folders and
does not remove folders that no longer exist upstream. When a Skill is renamed
— `vibehub-ticket-review` became `vibehub-review` — the old folder can survive
an update and present a stale duplicate Skill to the Agent. Delete the old
folder from `.claude/skills/`, `.agents/skills/`, or wherever your host
installed it. Setup notices this for you: while it inspects the checkout it names any installed Skill folder whose name the plugin has retired,
along with the replacement. It only reports — the folder is inside your agent
directory, so deleting it stays your action.


## Requirements

- Claude Code or Codex with plugin/Skill support
- Node.js 20+ for bundled validation scripts
- Git for history, collaboration, and rollback

## Start in a repository

VibeHub is optional. You can chat and implement without creating Tickets. To
choose the Ticket workflow, describe the deliverable and ask naturally to use
VibeHub. One example is:

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

Setup defaults to local-only records and no GitHub integration. New `.vibehub/`
records are ignored by normal Git staging; existing tracked records remain
tracked. Managed setup instructions stay inside the ignored folder. No remote,
GitHub login, Issue mirror, or publication is required.

GitHub mirroring is installed only on explicit request and requires the repository
Actions variable `VIBEHUB_GITHUB_SYNC=true`. See [GITHUB_ISSUES.md](GITHUB_ISSUES.md).
The commit-producing upgrader leaves ignored VibeHub records untouched and reports
`local-records`; use the local migration helpers for those records.

## Upgrade the plugin and project data

Plugin code and checked-in project data have separate lifecycles. Updating a
plugin bundle never writes `.vibehub/`. The installed helper first reports the
repository compatibility state:

The supported `npx skills` updater detects plugin changes by content hash or
an unconditional refetch; it does not depend on VibeHub's declared release
version. VibeHub therefore ships no separate staleness command. Release
versions remain human-facing identities for reproducible artifacts and their
paired data migrations.

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

## Unified dashboard

When you choose VibeHub, your agent automatically opens one home for projects,
registered worktrees, goals, and tickets before continuing your request. A live
host already known in the session is reused without another tab. You do not
need to run a dashboard command. Asking to keep it closed overrides startup.
If the browser or host is unavailable, your work continues in conversation.

The bundled `vh-start.mjs` helper implements entry and capability-checked reuse;
it connects the existing personal-hub config pointer when available. Project
roots already selected by you are carried forward; otherwise discovery starts
at the current checkout and its registered worktrees. Installation alone does
not trigger startup.

For manual launch or troubleshooting only:

```bash
node <plugin>/skills/vibehub-core/scripts/vh-ui.mjs --dashboard \
  --root <projects-directory> --personal-store <personal-hub-data-directory>
```

Repeat `--root` for additional project directories. Discovery descends up to
four directory levels, skips hidden and dependency/build directories and
symlinks, and shows only worktrees with a `.vibehub/version.yaml` connection
marker, or repositories explicitly linked by the connected personal store's
`project_refs` (exact path or an unambiguous project name). Unrelated repositories
are omitted, while connected checkouts needing
repair remain visible with their read errors.
Point `--root` directly at a repository for locations outside that discovery
scope. Refresh repeats discovery. No persistent registry is created.

`--personal-store` is optional and reads the JSON-compatible YAML records
written by vibehub-personal. Its goals and task membership remain distinct
from dependency arrows. This dashboard never writes to that store. The All
work view includes current graphs from discovered VibeHub worktrees, with
workspace-scoped identities so identical Ticket IDs in different checkouts
remain distinguishable. Invalid checkouts are reported individually.

Select a worktree to see its Git-style ticket flow or to copy a freeform
request with its exact path into your agent. Ticket setup is optional. A
Ticket's inspector opens the existing Contract/Evidence Workbench. Copying
context does not launch an agent; the dashboard has no execution runtime.
The default per-repository Workbench command remains available below.

## Ticket graph presentation

Ticket Skills proactively present the focused graph after planning, at a
protected human boundary, after closeout, and for PR review. Routine execution
stays quiet. To open the graph explicitly as a fallback, ask the Agent to use
`$vibehub-review` or launch the bundled helper:

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

### Dashboard hierarchy and recorded Context

A project opens its goal graph. Selecting a goal opens the graph of its linked
tickets; Back to goal graph returns to the project. Goals use the connected
personal store's explicit `project_refs`; `task_of` and `sub_goal_of` establish
membership. Dependency edges remain distinct from membership. Existing tickets
without a recorded goal remain under Unassigned tickets. The dashboard does
not infer goals from ticket titles or create records to fill an empty graph.

The Context view reads canonical records under `.vibehub/rooms/`, grouped by Room
and worktree. Selecting a record displays its saved detail, source, capture time,
tags, evidence, and relations. It is a read-only view of recorded knowledge,
not conversation capture. Invalid checkouts are reported individually.
