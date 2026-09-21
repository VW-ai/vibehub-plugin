# Ticket state and Agent session observations

Ticket state is a read projection of canonical Git data, exposed as
`ticket_state` by `ticket get`, `ticket graph`, and `ticket frontier`, and as
`workState` in the Workbench. The values are READY, BLOCKED, AWAITING_REVIEW,
NEEDS_HUMAN, NEEDS_REFINEMENT, NEEDS_REPLAN, and DONE. Existing operational
`status` and `next_action` retain their meanings. Session reports, process exit,
and browser state never change Ticket completion, authority or unlocks.

`agent-session.schema.json` defines a separate local observation. One session
belongs to one Ticket in one worktree, and records the agent's ID/name,
provider, optional host session ID, operation, source, state and timestamps.
Several sessions may report on the same Ticket. These are associations, not
exclusive assignments, locks on work, scheduling, authentication to a provider,
or proof that one agent owns the Ticket. Assignment and identity are immutable
within a session; start another session to switch Tickets.

## States and freshness

A session starts READY or another nonterminal state: `ready`, `running`,
`waiting_tool`, `waiting_human`, or `paused`. Reports can move between these
states or end the session as `completed`, `failed`, or `cancelled`. Terminal
sessions cannot be revived; a later attempt gets a new ID. Waiting for a human
in a session does not itself create a human-authority Ticket criterion.

- `last_reported_at` changes on every accepted state report or heartbeat.
- `last_activity_at` changes on explicit `activity: true` or a state transition,
  not on a heartbeat. It is activity reported by the source, not an inferred
  model-thinking or tool-use measurement.
- Freshness defaults to 30 seconds (configurable 1–300 seconds). Active reports
  whose expiry passes project as `effective_state: disconnected`. A later
  authorized report can restore freshness; terminal sessions remain terminal.
- Source `agent_report` means an explicit agent/adapter report. Source `process`
  means the foreground wrapper observed the process; it cannot infer waiting,
  thinking, or productivity from process liveness. Detailed waiting states
  still require reports from the child or adapter.

Local reports are labelled and trusted only as scoped observations, not as
identity attestations. A fresh, relevant execution/closeout report can light
up the existing live indicator. The card preserves DONE, blocked, refinement
and replanning precedence; the Execution inspector always shows Ticket state
and all session states separately. Runtime expiry does not invalidate semantic
snapshot IDs or Evidence. The read-only browser polls observations every five
seconds, stops polling while hidden, and clears live claims on fetch failure.

## Storage and writer ownership

The helper stores private JSON envelopes at the worktree-specific path returned
by `git rev-parse --git-path vibehub-runtime/sessions`. In a regular checkout
this is `.git/vibehub-runtime/sessions/`; linked worktrees have independent Git
metadata paths. No runtime files enter `.vibehub/`, commits, or clone transfers.
The records survive UI restarts but remain disposable local observations.
Deleting this directory discards observations without changing Ticket truth.
No project-format migration is required; this is not a canonical document layer.

Each record has a random writer token whose hash stays private. Process sessions
also have a separate finalization credential held only by the wrapper; child
reports cannot mark the observed process completed, failed or cancelled. Reports must
supply the token and `expected_revision`. Conflicting revisions fail instead
of replacing newer reports. A short-lived per-session filesystem mutex prevents
simultaneous read/modify/write races; a crashed writer may leave `<id>.json.lock`.
After confirming that no writer remains, the local operator may remove that
empty lock directory and retry. Never infer semantic work ownership from it.
Malformed files are excluded and surfaced as errors, never repaired into live
claims. CLI and UI read projections omit the token and hash. This protects
against accidental competing writers, not a malicious user with filesystem
access.

## Explicit reporter

Use the bundled helper; no global install, daemon or provider hooks:

```text
node ../vibehub-core/scripts/vh-session.mjs start --repo <root> --input <start.json>
node ../vibehub-core/scripts/vh-session.mjs list --repo <root>
node ../vibehub-core/scripts/vh-session.mjs report --repo <root> --input <report.json>
node ../vibehub-core/scripts/vh-session.mjs heartbeat --repo <root> --input <heartbeat.json>
```

`start.json` contains `ticket_id`, `agent_id`, `agent_name`, `provider`, and
optionally `host_session_id`, `operation` (`execute`, `closeout`, `plan`),
`state`, `freshness_ms`, and a short `message`. Start returns `{session, token}`.
Redirect the start envelope to a private local file; never put the token in
Tickets, Context, Evidence, URLs, command arguments or chat. A report contains
`session_id`, `token`, `expected_revision`, and optional `state`, `activity`
and `message`. Get the current revision from `list` before preparing a report.
A heartbeat changes only connectivity timestamps, never state or activity.
Do not store prompts, command arguments, tool output or credentials in messages.

An agent working through ordinary host tools can start its session, report
state/activity at meaningful boundaries, and close its session when that work
ends. If it cannot keep reporting, allow the session to expire; never leave a
heartbeat process running merely to manufacture presence. A stale report does
not prove that the underlying agent stopped. Existing native sessions are not
automatically discovered, resumed or controlled by this integration.

## Foreground command integration

```text
node ../vibehub-core/scripts/vh-session.mjs run --repo <root> --input <start.json> -- <executable> <args...>
```

The wrapper validates the Ticket, creates a process-observed session, inherits
command I/O without storing it, sends heartbeats while the process is alive,
and reports exit or spawn failure. SIGINT/SIGTERM are forwarded; noninteractive
children use their own process group so cancellation includes descendants,
with a three-second grace period before SIGKILL. Interactive children retain
the caller's terminal and receive forwarded signals directly. Unexpected
wrapper death leaves a report that expires; the wrapper is not a supervisor.

The child receives `VB_SESSION_ID`, `VB_SESSION_TOKEN`, and `VB_SESSION_REPO`.
An adapter inside the child can use these with `report` to announce waiting,
resumption or meaningful activity; supply the current `expected_revision`.
Pure `heartbeat` can reread the revision automatically. The wrapper also
rereads before pulses, avoiding overwriting a child's waiting state. A child
should leave terminal reporting to the wrapper. Exit zero means only that the
process completed, never that the Ticket passed acceptance.

Provider-native auto-discovery and hooks are separate integrations. This slice
works with explicit reporting and commands launched through this wrapper;
it does not claim to observe unrelated pre-existing host sessions.
