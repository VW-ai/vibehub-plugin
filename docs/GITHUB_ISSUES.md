# Tickets on GitHub Issues

GitHub publication is disabled by default. Local VibeHub work requires no
GitHub account or remote. Installation copies the workflow and its seven-file
bundle, but publication requires the repository Actions variable
`VIBEHUB_GITHUB_SYNC=true`. Share only the records you intend to publish.
New local records are ignored by normal staging; existing tracked records
remain shared.

## Authority and generated content

Git is the source of truth. This is a one-way projection of committed Tickets.
The script never imports Issue edits, changes Ticket records, or creates Git
commits. Human Issue comments remain discussion. Durable decisions enter
through `$vibehub-ingest`.

| Ticket fact | Issue representation |
| --- | --- |
| `outcome`, `context` | Outcome and Background sections |
| Active `acceptance` | Criteria with their stable IDs and human decision owners |
| `constraints`, `context_refs` | Constraints and source links |
| `relations` | Native Blocked by relationships and dependency rationale |
| `status` and unfinished prerequisites | One state label: open, in-progress, blocked, or done |
| `updates`, `deliveries` | Recorded progress, results, and delivery links |
| Evidence | One comment per Evidence ID, ordered by `recorded_at` |
| `status: done` | Closed Issue; reopening a Ticket reopens its Issue |
| Bound historical Outcome | Historical Outcome section, independent of current task status |

Identity is the first-line `<!-- vibehub:ticket-id=… -->` header in an Issue
body. Evidence comments use a first-line `<!-- vibehub:evidence-id=… -->`
header. Marker examples elsewhere in prose do not establish identity. Duplicate
Issue or Evidence identities fail before publication. The repository stores no
Issue numbers. Unmarked Issues, human discussion, foreign labels, and foreign
blockers remain untouched. Generated titles, bodies, task state, and managed
labels follow the committed Ticket.

Historical Evidence comments are append-only by ID. A changed comment body is
reported, not overwritten. Mirrored Issues whose Ticket no longer exists in the
selected source are reported as orphans and remain untouched.

## CI behavior

The workflow validates the committed candidate on every push and pull request,
without path filters, a GitHub token, or Issue write permission. This check runs
even when publication is disabled. The workflow summary states whether the
repository has enabled publication. A push with several commits validates its
final tree.

After that check, an enabled default-branch push starts the publisher. Only
publishing jobs share a concurrency group. Each publisher fetches the current
default branch after entering that group, validates its committed records, and
pins that commit for the whole run. This prevents a delayed run from projecting
an older queued event. Publication depends on projection validation. The separate
`Verify VibeHub` workflow still runs the complete repository checks independently.

Manual dispatch defaults to a read-only preview. A dispatch can use code from a
feature branch while projecting current default-branch records. Only a manual
publish run gets Issue write permission, and it still requires the repository
opt-in. Preview and publication produce downloadable JSON receipts. Offline
checks and previews do not enter the publisher's concurrency group.

## Command modes and receipts

All modes read an isolated checkout of a resolved Git commit with its history.
Ignored, untracked, staged-only, and modified working files cannot enter the
projection. An absent committed VibeHub project reports `no-shared-project`.
A partial or invalid committed project fails with its file paths and validation
diagnostics.

```sh
# Offline validation; no GitHub account or network is needed.
node scripts/sync-github-issues.mjs --repo . --ref HEAD --check

# Remote preview; reads GitHub but performs no writes.
node scripts/sync-github-issues.mjs --repo . --ref origin/main \
  --github VW-ai/vibehub-plugin --dry-run --report /tmp/issue-preview.json

# Explicit maintenance publication from the current canonical branch commit.
node scripts/sync-github-issues.mjs --repo . --ref origin/main \
  --github VW-ai/vibehub-plugin --publish --report /tmp/issue-sync.json
```

`--ref` defaults to `HEAD` for checking and previewing. Publication requires an
explicit ref and confirms that its commit equals the destination's current
default-branch head. Fetch that branch before a local maintenance run. Normal
publication uses Actions; independent local and Actions writers must not run
concurrently. The repository variable controls Actions publication. A local
`--publish` command is itself an explicit opt-in.

`--report` saves the record commit, implementation commit, mode, planned and
completed operation identities, remaining operations, confirmed mutation-request
count, diagnostics, and convergence result. It excludes Issue bodies and tokens.
The record commit belongs in the receipt, so unrelated commits do not rewrite
every Issue body. Ordinary file links use the canonical branch; versioned
Context refs link to their recorded commit.

The publisher reads every page of Issues, labels, repository comments, and
blockers. It skips blocker reads when GitHub reports zero blockers, and skips
comments when every mirror has zero comments. Missing counts trigger a full read.
It creates missing Issues before resolving their numbers in bodies and dependencies.
A dry run lists those future operations by Ticket ID. Label definitions change
only when their color or description differs. Managed labels are added and
removed individually so concurrent human changes to unrelated labels survive.
A repeated, unchanged projection makes zero mutation requests and requires only
one complete remote read followed by a canonical-head check.

After writes, the publisher reads GitHub again and requires an empty remaining
plan. A changed canonical branch reports `superseded`, rather than claiming that
the latest source converged. A failed or ambiguous request stops the run without
blind retries. Its receipt identifies the failed operation and pending work.
A fresh run discovers completed writes from the remote markers and resumes.
This supports recovery from partial runs; it does not guarantee exactly-once
creation under concurrent independent publishers.

## Which GitHub view to follow

GitHub has no dependency-graph view; the VibeHub Workbench remains the place
to see the whole graph. On GitHub itself there are three useful surfaces.

### 1. Issues list with label filters — recommended default

Zero setup; the sync keeps it current. Blocked Issues show a red
**Blocked by** pill. Useful saved filters:

| View | URL |
| --- | --- |
| Everything open | `https://github.com/VW-ai/vibehub-plugin/issues` |
| Open | `…/issues?q=is%3Aopen+label%3A%22state%3A+open%22` |
| In progress | `…/issues?q=is%3Aopen+label%3A%22state%3A+in-progress%22` |
| Blocked | `…/issues?q=is%3Aopen+label%3A%22state%3A+blocked%22` |
| Done | `…/issues?q=is%3Aclosed+label%3A%22state%3A+done%22` |

Provides automatically: task state, blocked marker, and Evidence comments.
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
