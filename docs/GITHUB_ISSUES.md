# Tickets on GitHub Issues

Every Ticket on `main` is mirrored to a GitHub Issue by
`.github/workflows/sync-issues.yml`. The mirror is one-way: Git is the source
of truth, the workflow never commits, and nothing written on GitHub flows back
into `.vibehub/`. Comments on an Issue are discussion; a durable decision still
enters through `$vibehub-ingest`. No Agent runs or checks the sync — a failure
is a red check under Actions.

What each Issue carries:

| Ticket fact | On the Issue |
| --- | --- |
| `outcome`, `context_refs`, `constraints` | Body sections; refs link to the file on `main` |
| `acceptance` | Task list, checked from the current Outcome; human-authority criteria marked 👤 |
| `relations` (`depends_on`) | Native **Blocked by / Blocking** relationships plus a Dependencies section with the rationale |
| state / maturity | Labels `state: ready · blocked · needs-human · close-out · refine · replan · done` and `maturity: firm · draft` |
| Evidence | One comment per record, in `recorded_at` order |
| successful Outcome | Issue closed, Outcome record in the body |

Mapping lives in a hidden `<!-- vibehub:ticket-id=… -->` marker in the body, so
renaming or re-creating a Ticket file keeps its Issue. Run
`npm run issues:sync:dry-run` to see what a sync would do without writing.

## Which GitHub view to follow

GitHub has no dependency-graph view; the VibeHub Workbench remains the place
to see the whole graph. On GitHub itself there are three useful surfaces.

### 1. Issues list with label filters — recommended default

Zero setup; the sync keeps it current. Blocked Issues show a red
**Blocked by** pill. Useful saved filters:

| View | URL |
| --- | --- |
| Everything open | `https://github.com/VW-ai/vibehub-plugin/issues` |
| Ready to execute | `…/issues?q=is%3Aopen+label%3A%22state%3A+ready%22` |
| Waiting on a human | `…/issues?q=is%3Aopen+label%3A%22state%3A+needs-human%22` |
| Blocked | `…/issues?q=is%3Aopen+label%3A%22state%3A+blocked%22` |
| Drafts to refine | `…/issues?q=is%3Aopen+label%3A%22maturity%3A+draft%22` |
| Done | `…/issues?q=is%3Aclosed+label%3A%22state%3A+done%22` |

Provides automatically: state, maturity, blocked marker, Evidence count.
Cannot show: the dependency chain beyond one hop, or any ordering by time.

### 2. Per-Issue sidebar — for walking the graph

Also zero setup. The **Relationships** section lists *Blocked by* and
*Blocking* in both directions, so a reader can traverse upstream and
downstream one Issue at a time. `gh issue view <n>` prints the same rows.
Closed blockers are not counted in the Blocked pill, which matches Ticket
semantics (a DONE prerequisite no longer blocks).

### 3. Projects board or roadmap — optional, one-time human setup

A repository Project can show the mirror as a board grouped by `state` label,
or as a roadmap. It needs one-time setup by a person because the Actions
token cannot create Projects:

1. Repository → **Projects** → **New project** → Board.
2. Project **Workflows** → *Auto-add to project* → filter `is:issue` so every
   mirrored Issue joins automatically.
3. Group the board by **Labels** (or add a single-select field and a second
   workflow mapping `state:` labels to it).

After that the sync feeds it with no further action. Provides: a kanban by
state, the Blocked icon, and Insights charts. Cannot show: dependencies as
edges, and the board reflects labels only as fast as the sync runs.

**Recommendation:** link the Issues list (1) from the README as the default;
readers who need the chain use the sidebar (2); create a Project (3) only when
a team wants a board.
