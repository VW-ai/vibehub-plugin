<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/vibehub-logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/vibehub-logo.svg">
    <img src="assets/brand/vibehub-logo.svg" alt="VibeHub" width="360">
  </picture>
</p>
<p align="center"><strong>Stop managing chats. Manage the work.</strong><br>Turn one coding request into a Git-native Ticket with the exact Context needed to plan, execute, prove, and close it.</p>
<p align="center"><a href="https://vibehub.team"><strong>vibehub.team</strong></a> · <em>Memory tools preserve the conversation; VibeHub preserves the development cycle.</em></p>

## Install

One line for any skills-capable agent — Claude Code, Codex, Cursor, and more. Choose **Select all** in the picker.

```bash
npx skills add VW-ai/vibehub-plugin
```

Update later with `npx skills update`. This is the only supported install path; host marketplace distribution was retired.

Then open the repository in a fresh Agent session, describe one concrete deliverable, and say:

<h3 align="center"><code>Start this with VibeHub.</code></h3>

**What you get**

- **One Ticket per request, in Git.** Acceptance contracts evolve through append-only revisions; Evidence and Outcomes bind the exact revision they judged. Old success remains readable history without silently closing a newer contract, and every record stays an ordinary file next to the code.
- **A graph of the work, not a list.** The local Workbench shows DRAFT, READY, RUNNING, and DONE Tickets with their real prerequisites and unlocks, and tells you the next action.
- **Local by default.** Goals, Tickets, and Context work without GitHub. Sharing records and mirroring them to Issues are explicit opt-ins.

<img src="docs/assets/local-graph/quiet-workbench-desktop-2x.png" alt="VibeHub four-phase Ticket Workbench showing the current causal graph" width="1280">

## One home for your work

VibeHub opens its local dashboard when you choose to use it. Navigate projects and
worktrees, track goal progress, and open executable tickets with human decisions first.
Context is grouped into Rooms, with canonical references under Project authority.
Records stay local by default; GitHub sharing is opt-in. See the [dashboard guide](docs/DASHBOARD.md)
for navigation, previews, session behavior, and manual startup.

## How it works

Describe one coding request and say the line above. The request and exact Context shape one Ticket; work produces acceptance-linked Evidence; a separate Agent decides the Outcome; accepted learning returns to Context. Tickets, Context, Evidence, and Outcomes remain ordinary Git files, so another Agent can resume from repository truth while Git keeps the history reviewable and reversible.

1. **Plan** — the request plus checked-in Context becomes one Ticket with explicit acceptance criteria, dependencies, and constraints.
2. **Run** — an Agent executes from that contract and appends Evidence linked to each criterion.
3. **Close** — a *separate* Agent adjudicates every criterion and writes the Outcome; a criterion can name a human as its decision owner.
4. **Learn** — durable decisions return to Rooms of Context that the next Ticket reads. Golden truth such as an architecture graph or a game's contracts lives there as `authority` Context with update rules; Agents follow it, and a canonical change without its record blocks closeout.

## See what matters now

<img src="docs/assets/local-graph/workbench-ticket-action-2x.png" alt="Focused VibeHub Ticket with Verify and close as its Recommended action" width="1180">

**Take the next action from the Ticket.** Recommended action stays primary, its explanation appears on demand, and Contract plus Log keep acceptance, Evidence, and Outcome traceable to exact Git source.

<img src="docs/assets/local-graph/workbench-rooms-narrow-2x.png" alt="VibeHub Workbench Room open at a real 390 by 844 narrow viewport" width="390">

**Bring repository context in only when useful.** Rooms expose durable Context, consuming Tickets, and drift state on demand; the same read-only graph remains usable at a real narrow viewport.

## Work with your team on GitHub

<img src="docs/assets/github-issues/issue-blocked-by-2x.png" alt="A mirrored VibeHub Ticket as a GitHub Issue with state labels and a native Blocked-by relationship" width="1280">

GitHub integration is disabled by default. After explicit setup and enabling `VIBEHUB_GITHUB_SYNC=true`, GitHub Issues project the records you choose to share. The workflow runs on pushes to `main`, upserts one Issue per Ticket with the acceptance checklist, one comment per Evidence record, `state:` and `maturity:` labels, and native *Blocked by / Blocking* relationships, and closes the Issue when the Outcome is successful. Nobody — human or Agent — runs a sync. Project setup only installs it on request; [docs/GITHUB_ISSUES.md](docs/GITHUB_ISSUES.md) explains the mirror and which views to use.

## Learn more

[Product concept](docs/CONCEPT.md) · [Installation, upgrades, and coexistence](docs/INSTALL.md) · [Local graph design](docs/LOCAL_GRAPH_DESIGN.md) · [GitHub Issues mirror](docs/GITHUB_ISSUES.md) · [Release procedure](docs/RELEASE.md)

Apache-2.0
