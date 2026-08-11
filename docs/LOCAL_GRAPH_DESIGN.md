# Local graph design authority

The local graph is VibeHub's quiet execution instrument, not a generic YAML
viewer and not a small dashboard. Its first question is: **when this Ticket
finishes, what becomes executable next?**

## Retained product language

- One complete, deterministic, top-to-bottom direct-unlock graph is the primary
  object: proven foundations above, current work central, READY and BLOCKED
  downstream beneath. Forks, joins, blockers, deviations, and proof stay at
  their owning graph locus.
- The healthy surface is quiet. Matte cool neutrals carry the base; semantic
  color is reserved for truthful execution state. Hover and selection remain
  neutral interaction states.
- Tickets are bounded execution objects. Their outcome, position, connectors,
  and readiness aperture carry the hierarchy before labels, borders, cards, or
  schema terminology.
- Inspection is progressive and in situ. Selecting a Ticket or relation keeps
  the graph visible; strict contract, Context, Evidence, Outcome, provenance,
  and Git trace remain one further disclosure away.
- Compact system typography, the 6/10/16px shape vocabulary, restrained
  elevation, visible keyboard focus, readable contrast, and reduced motion are
  part of the production contract.
- Every affordance is honest. The UI only presents facts and actions available
  from the current canonical documents and read-only loopback host.

This translates the approved `quiet intelligence`, v8 spatial-workbench, and
causal Ticket review decisions preserved in Git history at `9dee0f0`.

## Deliberately removed direction

The rejected surface used warm paper, serif display type, decorative forest
green, a persistent status legend, floating card treatment, and an always-open
schema-forward Inspector. Those choices made the graph feel like an internal
data viewer and contradicted the approved Workbench authority. They are not a
VibeHub brand direction.

## Architecture that does not return

The historical design does not authorize the historical runtime. This surface
does not restore SQLite, MCP, hooks, leases, a dispatcher, ContextBinding,
attestation, writable review operations, or hidden lifecycle state. It consumes
fresh schema-valid Context, Ticket, Evidence, and Outcome files mechanically.
Git remains the only durable truth; selection, layout, pan, and zoom are
disposable view state.

## Interaction depth

The surface borrows the calm, content-first interaction logic of a modern AI
workspace without copying another product's brand skin. Black, white, and gray
carry reading; VibeHub's cool wash and semantic state color appear only where
they communicate environment, execution, proof, or attention.

- In three seconds, the graph establishes the exact worktree, executable
  frontier, causal direction, blocker, and deviation state.
- In ten seconds, selecting a Ticket becomes one execution lens: outcome,
  operational state, direct prerequisites and unlocks, and proof availability
  remain visible without repeating state prose.
- In thirty seconds, Contract and Proof layers expose acceptance as an
  Evidence rail, constraints as guardrails, bound Context as governing objects,
  and Evidence plus Outcome as a chronological proof trace.

Different canonical objects do not collapse into one generic text list.
Tickets, dependencies, acceptance, constraints, Context, Evidence, and Outcome
each receive a visual primitive matching their role. The UI may request new
structured mechanical projection when that primitive needs existing canonical
facts, but it may not infer missing semantics or create a parallel state model.

## Current review surfaces

These real-browser captures use one disposable canonical fork-and-join Ticket
fixture. The fixture itself is not product state; the two images are retained
so owner review and future design drift checks bind to exact visual evidence.

![Desktop causal Ticket graph](assets/local-graph/quiet-workbench-desktop.jpg)

![Narrow progressive Ticket Inspector](assets/local-graph/quiet-workbench-narrow.jpg)

## User-owned Workbench session

Agent-launched review hosts intentionally expire with the Agent task and its
30-minute bearer token. To keep the same read-only Ticket graph open while you
develop — without creating or continuing any Agent conversation — start the
user-owned Workbench session yourself from the plugin bundle or a checkout:

```bash
node skills/scripts/vh-workbench.mjs --repo /path/to/your/worktree
```

The command prints an authorized local URL, opens your browser, and keeps the
loopback host alive until you press Ctrl+C; stopping the foreground process
ends the host and invalidates the URL. The session also watches
`.vibehub/**` and the Git HEAD and index of the selected worktree: bursts of
Agent writes coalesce into one revalidated reprojection and the open graph
refreshes itself, while invalid or half-written YAML keeps the last valid
view with a visible validation notice until the files become valid again. The lifetime belongs to that command:
no expiry timer, and also no daemon, PID file, registry, or background start.
The session preserves every Agent-host guarantee — it binds only 127.0.0.1,
serves only GET and HEAD, keeps the bearer token in memory and the URL
fragment, projects fresh from `.vibehub/` on each request, and leaves Git YAML
byte-for-byte unchanged. `--no-open`, `--json`, `--port`, `--ticket <id>`, and
`--view <execution|contract|log>` work exactly as they do for the Agent
launcher documented in the Ticket review Skill.

### The macOS Workbench shell

`apps/workbench/` is a thin macOS WKWebView shell around that same session. It
is not part of the Skill plugin and is never bundled into the plugin artifact.

```bash
cd apps/workbench && swift build          # runnable binary in .build/debug
sh apps/workbench/Scripts/make-app-bundle.sh   # optional VibeHub Workbench.app
open "apps/workbench/.build/VibeHub Workbench.app"
```

The package splits exactly the lifecycle adapter the shell owns and nothing
else: `WorkbenchRepositorySession` (exact worktree, Git metadata, preference
allowlist), `WorkbenchWebViewBridge` (starting and stopping the read-only host,
the in-memory token, the navigation policy), and `WorkbenchDesktop` (window,
directory selection, session lifetime).

On launch the window lists recent repositories and opens `NSOpenPanel`
restricted to directories. Choosing an exact Git worktree spawns
`node skills/scripts/vh-workbench.mjs --repo <path> --no-open --json` inside the
app session, reads the authorized URL from its first stdout line, and loads that
URL in a `WKWebView`. Projection, layout, and the frontend are not
reimplemented: the WebView renders the same `app.css` and `app.js` the browser
mode serves, over the same read-only API. Quitting the app — including a plain
`kill`, which AppKit would otherwise not intercept — terminates the host process
and with it the watcher and the token; nothing is left listening. One honest
exception remains: `SIGKILL` cannot be handled, so force-killing the shell
leaves its host running until you stop that process yourself.

The shell persists only the §8.2 allowlist, in the
`dev.vibehub.workbench.preferences` domain: `recentRepositories`, `windowFrame`,
`lastTicketId`, and `lastInspectorTab` (the last two keyed by exact worktree).
The bearer token, Ticket states, the frontier, and projected snapshots are never
written; every Ticket state is recomputed from Git YAML on each launch. The last
Ticket and inspector tab are restored through the frontend's existing
`?ticket=<id>&view=<execution|contract|log>` contract. **Graph pan and zoom are
not restored.** §8.2 permits persisting them, but the shared frontend keeps
pan/zoom in a closure and exposes no viewport contract, so restoring one would
require forking the frontend; the shell records nothing it cannot honestly
reproduce.

The WebView never receives local file permission. It is allowed exactly one
origin — the loopback session this app started — and there is no
`WKScriptMessageHandler`, no injected user script, no `loadFileURL`, and no
persistent data store. Remote links a user clicks open in the default browser
instead. `VibeHubWorkbench --probe-navigation`, `--probe-preferences`,
`--probe-session`, `--probe-render`, `--probe-deep-link`, `--probe-menu`,
`--probe-recents`, and `--probe-switch` expose these boundaries headlessly, and
`test/workbench-shell.test.mjs`, `test/workbench-deep-link.test.mjs`, plus
`test/workbench-switch-repository.test.mjs` assert them (skipping when no Swift
toolchain — or, for the window-server probes, no GUI session — is present).

#### Changing repository without quitting

The menu carries two entries, both reachable while a repository is open:

| Entry | Key | What it does |
| --- | --- | --- |
| **File ▸ Open Repository…** | Cmd-O | The same `NSOpenPanel` the launch surface offers, sheeted on the window you are looking at. |
| **File ▸ Recent Repositories** | — | One item per remembered worktree, most recent first, titled with the worktree's directory name and carrying the exact absolute path (also its tooltip). |

Both hand one exact worktree to a single entry, `AppDelegate.requestRepository`,
which validates it and then asks `DeepLinkPlanner` — the same planner
`vibehub://open` uses. There is one switching semantics, not two:

| Situation | Behaviour |
| --- | --- |
| Already open on that worktree | Focus the window. The host is not restarted for a repository that is already on screen. |
| No repository open yet | Open it. Choosing a worktree in the app *is* the explicit yes a link arriving from elsewhere has to ask for. |
| Open on a different worktree | The §9.3 question, as a sheet on that window. **Switch Repository** switches; **Stay Here** leaves the session — host, port, window, and remembered list — exactly as it was. |

The question is the same one a deep link raises: same title, same two buttons,
same two paths, same consequence. Only the line naming who asked differs
(*"A vibehub:// link asked for:"* versus *"You asked to open:"*), because
telling someone who just picked a worktree from a menu that a link asked for it
would be false. It is always a sheet on a real window, never an
application-modal alert — one raised at launch answers itself and ends the app.

A confirmed switch starts the new host *before* ending the old one, so a switch
that cannot start leaves the running session untouched. Once the new host
answers, the previous repository's host process, its `.vibehub/**` + Git
watcher, and its bearer end together, before the new window appears: no orphan
process, no port left listening, and the URL that was authorized a moment ago
resolves to nothing. The window is **replaced, not re-pointed** — swapping a
live `WKWebView`'s URL across a repository switch crashes the shell — and
closing the old one writes the frame you arranged so the new one restores it.
Every Ticket state in the newly opened repository is recomputed by its own host
from its own Git YAML; nothing projected is carried across.

The remembered list is updated on each successful open and pruned only when the
failure is a property of the path itself:

| Failure | Remembered list |
| --- | --- |
| `notADirectory`, `notAnExactWorktree`, `notAVibeHubRepository` | Entry dropped — choosing it again could only fail again. |
| `gitFailed` | Entry kept. Git being unavailable or a volume not mounted yet is temporary, and a temporary problem must never erase a repository you still work in. |

Either way the failure is stated in words, on the open window when there is one
and on the launch surface otherwise. Nothing new is persisted: the allowlist is
still exactly `recentRepositories`, `windowFrame`, `lastTicketId`, and
`lastInspectorTab`.

Browser mode is deliberately unchanged: `vh-workbench.mjs` binds one `--repo`
per foreground command, and moving repository selection into the page would
require the shared frontend to address more than one host.

#### Deep links

The app bundle claims one URL scheme, `vibehub`, and handles it through
`kAEGetURL`:

```text
vibehub://open?repo=<absolute-path>&ticket=<ticket-id>&view=<execution|contract|log>
```

`repo` is required and must be an absolute path with no `..` segment; `ticket`
must be a canonical Ticket ID; `view` is one of exactly those three layers and
requires `ticket`, mirroring the launcher rule. Nothing else is accepted — an
unknown scheme or action, an unknown or repeated parameter, a URI fragment,
credentials, or a port is refused whole, and a refusal opens nothing, reads no
repository, and writes no preference. **A deep link carries navigation only.**
It names a repository, a Ticket, and an inspector layer, and there is no
parameter through which it could create, change, or delete anything; the host it
addresses is the same read-only session, and the WebView boundary is unchanged
(`vibehub:` is not navigable inside the page). It deliberately says nothing
about pan and zoom, for the same reason the shell does not restore them.

Before anything is focused, opened, or asked, the named path is validated
exactly as a directory chosen in `NSOpenPanel` is: an exact Git worktree root
holding `.vibehub`. Then:

| Situation | Behaviour |
| --- | --- |
| Workbench already open on that worktree | Focus the window and re-address the authorized URL at the Ticket and layer. |
| Not running, worktree already in `recentRepositories` | Open it directly. |
| Not running, worktree seen for the first time | Ask first — a sheet naming the path, opening only on **Open Repository**. |
| Open on a different worktree | Ask first — a sheet naming both paths, switching only on **Switch Repository**. Declining leaves the session untouched. |
| Ticket not checked in by that worktree | Open the repository anyway and say so: *"<id> is not in this worktree."* |

That last row is why the shell checks `.vibehub/tickets/<id>.yaml` before it
passes `--ticket` to the host: the host refuses to start on an unknown Ticket,
which would keep the repository itself from opening. The launcher's validation
is unchanged and still authoritative; the shell simply never asks it to bind a
Ticket that is not there, which also means a stale `lastTicketId` preference can
no longer block a launch.

Deep links are an enhancement. The Workbench opens, watches, and renders with no
Agent, no deep link, and no URL scheme registered at all.
