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

Update later with `npx skills update`. This is the only supported install path; host marketplace distribution was retired.

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
The dashboard is read-only and does not start an agent. See the
[dashboard guide](docs/DASHBOARD.md) for navigation and manual startup.

Optional [session observations](skills/vibehub-core/contracts/agent-session.md)
show agent activity separately from task status. A process exit never completes
a task. Shared records can also be [mirrored to GitHub Issues](docs/GITHUB_ISSUES.md).

## Learn more

[Product concept](docs/CONCEPT.md) · [Installation, upgrades, and coexistence](docs/INSTALL.md) · [Local graph design](docs/LOCAL_GRAPH_DESIGN.md) · [GitHub Issues mirror](docs/GITHUB_ISSUES.md) · [Release procedure](docs/RELEASE.md)

Apache-2.0
