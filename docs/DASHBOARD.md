# Dashboard

The dashboard is built into VibeHub. When you choose or resume VibeHub work,
your agent opens it automatically and reuses it through the session. New project
records stay local and are ignored by Git; existing tracked records are not made
private by this default. Sharing code does not imply sharing planning records. There is
no separate dashboard startup step.

For manual launch or troubleshooting across your project directories:

```bash
node skills/vibehub-core/scripts/vh-ui.mjs --dashboard --root /path/to/projects
```

Add `--personal-store /path/to/personal-hub-data` to include personal goals and
tickets. The goal workspace keeps project, branch, and worktree navigation in
the sidebar. The searchable project picker shows connected project names and
paths, supports keyboard selection, and marks the current project. Open a goal to monitor its executable tickets, with segmented
progress bars showing completed-ticket counts. Goals default to an overview of progress cards. Tickets use six-column boards,
with actionable human input first, followed by working, ready, planning, waiting,
and completed work. Graph views preserve recorded
relationships. The engine's next-action projection determines ticket readiness;
goal lanes summarize the most urgent unfinished work. Context groups records into expandable Rooms with descriptions, record counts,
worktree provenance, and direct Room explorer links. Search keeps matching
records inside their Rooms; empty Rooms remain visible. **Context → Project authority** collects project-level canonical design systems, infrastructure diagrams, data models, and contracts.
Each resource opens its document first, with separate **Update rules** and **Record details** views.
Ticket popups lead with the full description, followed by saved completion criteria,
background, and constraints. Related goals, prerequisites, and unlocked tickets are
clickable; source paths and recorded next actions sit under collapsed Record details.
Copy decision brief or Copy work brief carries those requirements into the agent conversation.
Regular Context uses compact, searchable rows grouped by collapsible Rooms. Colored rails and circular nodes show recorded Room ancestry within each worktree; search retains ancestor Rooms for orientation. Within each Room, collapsible type groups (Decisions, Constraints, Contracts, and others) show record counts. Each row shows
its title, non-active state, and linked-ticket count; select it for full details.
Authority retains its reference cards. Evidence and file paths remain in Record details.
Each resource exposes its canonical files, governed scope, update rules, and validation. Authority
records retain their Room provenance; the catalog shows the selected worktree revision. Ordinary
Context stays in the Rooms tab beside Project authority. Canonical file previews support Markdown
documents and tables, CSV/TSV tables, code and structured text, and images (including SVG).
Mermaid and other diagram languages currently show their source. Previews are authenticated,
read-only, limited to recorded canonical files within the selected worktree, and bounded in size. The interface follows the system theme, and the
sidebar opens as a navigation popup on small screens. Refresh rereads recorded progress
while preserving your view and filters. Visible mouse, keyboard, and touch activity
renews the dashboard session; the host closes after about 30 minutes without activity.
There is no background keepalive. If the host has stopped, reopen through VibeHub for a fresh link.

Use **New goal** to copy a planning brief into your agent, or **Copy next steps**
to resume a goal with its current decisions and work frontier. These are agent
handoffs: the read-only dashboard does not launch an agent or submit approvals.
VibeHub is optional: no Ticket, special phrase, or response format is required for ordinary work.
