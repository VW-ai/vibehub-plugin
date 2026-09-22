# Project exploration UX study

This is a reviewable **synthetic interaction prototype**, not a connected App.
It uses fictional Atlas/Notebook projects and Mira/Noah/Iris participants. All
actions change page memory; reload/reset removes them. There is no repository
inspection, credential input, CLI execution, service request, model call or
canonical write. The loopback preview serves five allowlisted static assets;
its CSP forbids network connections and form submission. No external assets,
framework, dependency or sibling implementation is imported.

From the repository root:

```sh
node semantic-runtime/prototype/serve.mjs 51987
```

Open `http://127.0.0.1:51987/`. This is a different process/port from the Runtime
bootstrap at `127.0.0.1:50985`; it does not replace that service. Ctrl+C stops only
this static preview. An occupied port fails without taking over another process;
pass a different port if needed. Serving is loopback-only and accepts GET/HEAD.

## Navigation and state ownership

| Surface | Meaning and transitions |
| --- | --- |
| Overview | Project awareness independent of `main`. A/B/C are separate explorations and execution workspaces; A contains two Sessions. Inspecting a card selects a view without checking out Git. D is deleted but remains a historical origin. |
| Context & lineage | Room revisions retain role, applicability, rationale, pinned background and exact parents. A@1 is superseded by A@2 while its B@1 descendant remains current. Project constraint from deleted D remains applicable. Invalidation, unresolved conflict, inaccessible history and UI hiding/archive are distinct. |
| Tickets | Current-relevant, created, participated, execution-finished, accepted, Project-wide and archived views show inclusion reasons. T-24 spans A/B. T-21 has A creation/first attempt, B second attempt/completion and C independent review. |
| Project setup | Local launch/stop/restart, synthetic folder/Git-init/enrollment, external linked worktrees, provider secure-reference status, separate Worker subscription, Codex/Claude connection and explicit Project activation. GitHub is optional. |
| Preview state | Reproducible ready/offline/dormant/stale/unavailable/denied/empty/auth/quota/failure fixtures. This selector is a review tool, not a proposed product navigation element. |

Ticket hiding is keyed by demo viewer + Project + execution workspace + selected
view. Archiving is a viewer/workspace preference with a dedicated restore view;
it changes no shared status. Authorized dependency T-18 remains as a blocker on
T-24 even when T-18's row is hidden. Neither operation deletes a source or makes a
blocked Ticket complete. Context view hiding/archiving does not change a claim's
semantic state or applicability; the prototype exposes a restore control.

Notices demonstrate A→B and B→A. Inspect changes unread→seen only; continue and
defer preserve the receiving exploration. Review adoption opens the exact source,
recipient and before/after statements; only its explicit confirmation records a
synthetic adoption relation in Room lineage. There is no bulk/implicit adoption.
An adopted receipt is retained: later continue/defer actions cannot overwrite it
or create a second adoption relation. The demo disables those preference buttons.
Old/new Project background versions are visible; viewing v3 does not adopt it in B.
Paused/offline/stale/unavailable/denied states disable adoption. Real authorization
and expected-base validation must live in the service, not this browser fixture.

The separate WR-7 maintenance panel has selected input refs, a pinned instruction
bundle, named tools and parameter/output examples. Its demo lifecycle is offered
→ claimed → pending → completed. Repeated submission shows the same receipt;
the receipt acknowledges a proposal, not adoption or Ticket acceptance. A dormant
host cannot claim it. These are illustrative contracts, not installed tools or a
new request implementation. Development Tickets allow native coding and optional
skills; maintenance request tools do not dictate a developer's workflow.

## Service handoff

These are required response/command fields for future composition, **not claims
that these endpoints exist**. The accepted auth/store/provider modules and Git
enrollment/activation work are implementation inputs; their independent Outcomes
and documented APIs remain authoritative. UI fixture IDs/timestamps/epochs are
never sent to them or used as authentication.

| Boundary | Required fields and behavior |
| --- | --- |
| Project enrollment | Exact tenant/Project, catalog version, opaque repository/checkout/worktree IDs, current path/ref attributes, active/unavailable/removed state and observed-assurance limits. Inspect/init/enroll remain separate commands; explicit init never implies commit, remote or activation. Read Git inventory rather than recursively scanning folders. |
| Activation | Authoritative enabled state, monotonic epoch, expected record version, current enrolled membership and gap references. Explicit scoped command from App authority; read status is not a reusable permit. Disabled/result/delivery fences are enforced transactionally by service consumers. Already-started external work cannot be recalled; cancellation acknowledgement is not proof that a process stopped. |
| Provider settings | Selected route/model, capability/version status, secret reference and safe configured/error status. Real secret entry is native/local and must not reach URLs, browser persistence or logs. Provider/API billing and CLI subscription authentication remain separate. No silent route fallback. |
| Worker and plugins | Executor, safe auth/quota/failure status, pending job count and bounded recovery actions; host session ID, origin, capabilities, last observed event, per-source cursor/gaps. A connected plugin or active Session does not prove complete capture. Worker-origin events cannot recursively become user events. |
| Awareness | Notice ID, from/to exact exploration + revision, relevance reason, receiver/viewer, seen/deferred/continue receipts, explicit adoption reference, expected receiving base and current permissions. Use distinct delivery/seen/adopted states. Dormant notices can remain pending without waking a host. |
| Context | Exact claim/revision, semantic role, applicability, rationale, pinned source refs, state and reason, typed exact-parent relations for origin/fork/adoption/supersession/invalidation, current-access result or allowed tombstone. Per-exploration applicability is independent of another exploration's supersession. |
| Tickets | Exact Ticket/Contract refs; immutable creation event; participation, execution attempts/completions, independent acceptance and delivery events with workspace/session origins; authorized dependency summary; server-provided inclusion reason. Unknown origin stays unknown. |
| Preferences | Viewer/Project/workspace/view keys, hidden IDs and workspace archive preference. These never mutate Ticket status, graph eligibility or governing Context. Hidden dependencies retain permission-safe blockers. |
| Work requests | Request/Job/attempt IDs, exact scope and input/base refs, trusted instruction bundle, host-verified tool names/schemas, allowed operations, deadline, state, result digest and idempotent submission receipt. Fresh permission/base/activation checks precede real actions; proposal receipt is never an Outcome. |

On restart, keep the configured Project switch and retained history, require a
new service authentication context, and show outage coverage as unknown. Re-enable
starts a new epoch and records the disabled gap. The optional demo checkbox asks
to recover one previously saved T-24 job; it represents an explicit bounded
request pending revalidation, not immediate dispatch or permission to read missed
sessions. No private disabled-period conversation is automatically backfilled.

## Reproducible review tasks

1. Overview → inspect A: two Sessions share one worktree. Inspect B → its Tickets:
   T-24 remains relevant despite being created in A. No Git action occurs.
2. Inspect each directional notice: it becomes seen, not adopted. Continue one,
   defer the other. Review one adoption → confirm its exact revision → Context:
   only that explicit adoption is added to lineage.
3. Context → ctx-local@1 and ctx-queue@1: A is superseded, B is current. Inspect
   ctx-source@3 from deleted D; hide/archive it and restore. Its state never changes.
   Inspect the restricted tombstone and compare invalidated/conflict states.
4. Tickets → A/Created → B/Execution finished → C/Accepted: inspect T-21's attempts.
   Select B/Project-wide; hide T-18. T-24 retains the blocker. Switch viewer or view:
   T-18 reappears. Return to the original view and restore it.
5. Archive T-21, open Archived for the same viewer/workspace, restore it. Shared
   Accepted status persists. D's deleted-workspace view retains historical rows.
6. Inspect WR-7 → claim → start → submit → replay submission: demo-receipt-7 stays
   the same and never becomes adoption or acceptance. Dormant state prevents claim.
7. Setup → simulate secure reference for each provider; switch Worker between
   Codex/Claude. No key field exists. Preview expired auth/quota/failure; local login
   recovery only changes a fixture. No actual CLI runs.
8. Setup → select non-Git folder → explicitly initialize fixture → enroll Atlas.
   Review external worktrees and ref-without-checkout. Pause Project, continue to
   read history, re-enable without recovery, inspect the gap. Restart exposes
   reauthentication/unknown coverage. Notebook stays a separately disabled empty fixture.
9. Exercise every Preview state. Offline preserves last observation and blocks
   actions; empty is distinct from denied; unavailable does not fabricate source
   bytes; stale requires a fresh base. Native coding is never controlled by this page.

Keyboard: Tab from the skip link into sidebar links and native selects; Enter
opens each action; native dialog contains focus, Escape closes it and returns
focus to the opener when still present (otherwise the main landmark). Every
control has a visible label, focus ring and status text; changes announce through
one polite live region. No hover-only actions or keyboard-triggered animation.
Layout adapts at 1100/760 px; reduced motion is respected. No color alone conveys
semantic status. This is accessibility intent plus reviewable markup, not a WCAG
certification or a screen-reader test claim.

## Verification and open choices

`node --test semantic-runtime/prototype/prototype.test.mjs` passes six focused
checks for cross-workspace facts, scoped hide/restore, retained blockers,
archive/status separation, independent context variants and unavailable-action
gates, including adoption receipt retention under repeated/preference transitions.
`node --check semantic-runtime/prototype/app.mjs` and `git diff --check`
pass. Browser walkthrough is recorded separately in acceptance-linked Evidence;
these pure fixture checks do not prove browser behavior or service enforcement.

The parent Agent exercised the final prototype in the Codex in-app browser on
2026-09-22: default viewport had no horizontal overflow or console errors/warnings;
B→A seen/adopted and exact lineage, Ticket filtering/hide with retained dependency,
A/B context states and denied tombstone, setup separation, pause/re-enable gap,
request proposal receipt and reset all worked. Two findings were fixed and checked:
state-changing modal submissions retain focus on main, and adopted Context copy
reflects the explicit relation. Enter opens a request; Escape restores a surviving
trigger. This did not test mobile layout, a screen reader, TTY hosts or live APIs.
Independent source review additionally found and prompted fixes for a denied-state
Project-background disclosure path and adopted notices losing their receipt after
continue/defer. The denied button and handler now return no protected background;
the synthetic notice transition retains one adoption receipt/relation.

Open product choices: final terminology for exploration versus execution workspace;
default Ticket filter; timing and grouping of awareness notices; which adoption
needs a human rather than an authorized Agent; native-shell/secure-entry design;
placement of detailed audit history. The prototype is an Agent proposal for review,
not evidence that the user approved these choices. It introduces no generic UI
framework, production state store, queue or routing service.
