<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/vibehub-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/vibehub-logo.svg">
    <img src="assets/brand/vibehub-logo.svg" alt="VibeHub" width="360">
  </picture>
</p>
<p align="center"><strong>Remember the work.</strong><br>Keep tasks, context, relationships, and progress in files beside your project.</p>
<p align="center"><a href="https://vibehub.team"><strong>vibehub.team</strong></a></p>

## Install

One line for any skills-capable agent — Claude Code, Codex, Cursor, and more. Choose **Select all** in the picker.

```bash
npx skills add VW-ai/vibehub-plugin
```

This is the only supported install path; host marketplace distribution was retired. Node 20 or newer and Git are required.

Then open the repository in a fresh Agent session, describe one concrete deliverable, and say:

<h3 align="center"><code>Start this with VibeHub.</code></h3>

VibeHub records what you want to do and what has happened. Your own skills
choose how to research, design, implement, test, and review the work.

- Tickets hold the desired outcome, known completion criteria, context, and dependencies.
- Goals and Epics group related work when a request needs them. Standalone tasks need neither.
- Progress updates preserve the account of the work. Report a task as open, in progress, or done, and reopen it when needed.
- Context keeps project decisions, constraints, and canonical references available to future work.
- New records stay local by default. Git sharing and GitHub Issues mirroring are explicit choices.

## Record a task

Ask your agent to use `vibehub-ticket` to remember a task, read its context, or
update its progress. A task may start with only its ID and intended outcome.
Add criteria, relationships, and result references as they become known.

The bundled helper also accepts compact record inputs:

```json
{"ticket_id":"password-reset","outcome":"Users can reset a forgotten password."}
```

```bash
node skills/vibehub-core/scripts/vh.mjs ticket put --repo /path/to/project --input task.json
```

```json
{"ticket_id":"password-reset","update_id":"form-complete","summary":"The reset form is complete.","status":"done"}
```

```bash
node skills/vibehub-core/scripts/vh.mjs ticket update --repo /path/to/project --input update.json
```

Completion is a recorded status. VibeHub does not require a development sequence,
independent review, Evidence, or an Outcome to update it. Existing Evidence and
Outcomes remain available as historical proof with their original bindings.

## Read the project

VibeHub opens its local dashboard when you choose it. Browse tasks, dependencies,
progress, and Rooms of Context. Copy a task brief to work with your chosen skills.
The dashboard is read-only and does not start an agent. Switch projects and
worktrees, use the board or dependency graph, and inspect Room knowledge in the
Context view. Manual startup from the installed Skill directory is:

```bash
node ../vibehub-core/scripts/vh-ui.mjs --dashboard --repo /path/to/project
```

Discovery includes the checkout and its parent. Add `--root /another/project`
for other locations. Choose System, Light, or Dark in the dashboard.

Optional [session observations](skills/vibehub-core/contracts/agent-session.md)
show agent activity separately from task status. A process exit never completes
a task. To mirror shared records to GitHub Issues, explicitly ask your agent to
install the mirror through `vibehub-setup`, then enable the repository variable
`VIBEHUB_GITHUB_SYNC`. The mirror is one-way; Issue comments do not change records.

## Upgrade

For a release upgrade, install the Skills and run the upgrader from the same
immutable release tag. Replace `<release-tag>` and the explicit project path:

```bash
npx skills add https://github.com/VW-ai/vibehub-plugin/tree/<release-tag>
npx --yes --package=https://github.com/VW-ai/vibehub-plugin/releases/download/<release-tag>/vibehub-upgrade.tgz vibehub-upgrade --root /path/to/projects
```

The upgrader reports every discovered registered worktree, migrates only safe
clean worktrees, and leaves local reviewable commits. Nothing is pushed. Deferred
semantic changes use the installed [migration Skill](skills/vibehub-migrate/SKILL.md).
A plain Skills update does not migrate project data. Remove retired Skill folders
from your chosen installation scope when replacing older entrypoints.

## Project knowledge

Maintained project decisions and contracts live in the
[Room tree](https://github.com/VW-ai/vibehub-plugin/tree/main/.vibehub/rooms).
README and installed Skills provide entry instructions; executable schemas and
contracts remain beside their code. Historical design sources stay available
through the exact Git references recorded in Context.

Apache-2.0
