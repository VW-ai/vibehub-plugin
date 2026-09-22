# Semantic Runtime: local app and later online delivery

Status: revised product direction and planned work, not implemented service behavior.
Baseline: 2026-09-21, current implementation checkpoint f10a055.

## Current direction and source of truth

The original [PRD](02_prd_vibehub_semantic_runtime.md) and
[Tech Design](03_tech_design_semantic_runtime.md) remain unchanged proposed drafts.
This plan preserves their Policy Graph, Semantic Working Graph, ingress, query,
Context Compiler, source/canonical separation and selective reasoning architecture.
It updates delivery order and the local App, exploration/awareness and executor
product model from the owner's subsequent discussion. Durable decisions live in the shared Room:

- [Locally launched App with plugins and local subscription Workers](../../.vibehub/rooms/semantic-runtime/decision-runtime-local-app-product.yaml). The earlier local-first decision is retained as superseded history.
- [Branch/exploration scope versus worktree execution identity](../../.vibehub/rooms/semantic-runtime/decision-runtime-branch-exploration-scope.yaml).
- [Many Sessions per worktree and multiple attempts per Ticket](../../.vibehub/rooms/semantic-runtime/contract-runtime-ticket-exploration-participation.yaml).
- [Project overview and Room/context lineage](../../.vibehub/rooms/semantic-runtime/decision-runtime-project-overview-and-room-lineage.yaml).
- [Bidirectional awareness with explicit adoption](../../.vibehub/rooms/semantic-runtime/decision-runtime-awareness-before-cross-branch-adoption.yaml).
- [Internal capabilities and the real host integration boundary](../../.vibehub/rooms/semantic-runtime/decision-runtime-internal-capabilities-and-host-bridge.yaml).
- [Actionable requests with tools, schemas and receipts](../../.vibehub/rooms/semantic-runtime/contract-runtime-agent-work-request-tool-return.yaml).
- [Native local execution and independent reviewer parity](../../.vibehub/rooms/semantic-runtime/constraint-runtime-local-agent-skill-parity.yaml).
- [Client redesign scope](../../.vibehub/rooms/semantic-runtime/intent-runtime-client-redesign.yaml).
- [Reuse Collector mechanisms and measure host coverage](../../.vibehub/rooms/semantic-runtime/intent-runtime-collector-reuse-and-coverage.yaml).
- [Private networking as an unselected later option](../../.vibehub/rooms/semantic-runtime/note-runtime-private-network-collaboration-option.yaml).

The earlier online-first intent is retained as superseded history. Local work
no longer waits for a cloud platform/cost decision. That decision remains required
for its actual later hosted release. Tailscale, P2P replication, a cloud data
service and a remote reasoning Worker are not selected by this plan. Local
subscription Workers are part of the selected path. Local processing may still
call an authorized external model; local service
placement does not mean all inference or every data destination is local.

## Current readiness

Local bootstrap delivered 2026-09-22: `npm start` now serves a loopback status
page with SQLite readiness, `npm run status` checks it, and SIGINT/SIGTERM stop
the process while preserving data. This is the local-service-profile slice only;
app onboarding, project activation, provider settings, collection and Workers remain
pending. [Run instructions and boundaries](local-service-profile.md).

OpenRouter adapter delivered 2026-09-22: the pinned official AI SDK provider now
implements the existing four Judge families, with offline transport, failure and
cancellation coverage. Full component verification passes 296 tests. No live
OpenRouter request has been run; route availability remains unverified until the
synthetic smoke succeeds. [Adapter contract and smoke](openrouter-jev-adapter.md).

The [readiness checkpoint](../../.vibehub/rooms/semantic-runtime/note-runtime-foundation-readiness-20260921.yaml)
records 283 passing component tests and a successful heuristic replay of 20
sanitized Peel events / 80 decisions. This proves the current mechanisms, not
semantic quality or downstream product benefit. Existing live-provider benchmark
Evidence remains historical measurement; it was not rerun during this planning.

Already implemented: Phase 0 replay and SQLite audit; JEV/Haiku/direct TypeSafe
adapters; identity, provenance, causality, Git, Working Graph, Policy artifact,
non-model execution, Worker protocol, reconciliation and observability reference
contracts; isolated measured Node/Postgres spike. The newer kernel rejects
Judge/Worker nodes; the old replay model route is a separate working path.

Still missing: real Collector and durable service composition, typed extraction
and entity resolution, production Graph persistence/enrollment, branch-aware
views/adoption, integrated Judge runtime, query/compiler, actionable Agent
request delivery, bidirectional awareness, local app/provider settings, project
activation, two plugins and local Worker orchestration. Address resolution is
not semantic entity resolution. Same-entity concurrent assertions
in the current one-lineage Graph are not branch-local hypotheses.

## Delivery sequence

| Stage | User-visible or engineering outcome | Work |
| --- | --- | --- |
| L0 — close the important unknowns | Stable exploration contract, observed host coverage, runnable local profile, executable request contract, reviewable Project UX | Five existing firm foundations plus provider settings, OpenRouter adapter and the separate Claude host probe can run independently (eight L0 Tickets). |
| L1 — reliable local state and project control | Enroll a Git folder and all linked worktrees, enforce Project activation, durably accept events and persist scoped Graph state | Auth/store/ingress/Graph plus Git enrollment, activation and branch projection. |
| L2 — actual semantic write path | Local subscription Workers run bounded heavy jobs and return cited proposals; extract typed claims, resolve entities and execute policy | Local runner → Codex/Claude executors; extraction → resolution → ingress policy, with configured Judge routes and durable policy journal. Interactive Agent requests remain an additional delivery route. |
| L3 — useful reads and awareness | Compile scoped Context, capture measured Codex and Claude units, recover notices, expose A→B→A without implicit adoption | Query/compiler/API/session, separate Codex/Claude plugins, awareness, audit and telemetry. |
| L4 — usable local app | Launch, select folder, configure provider and Worker, enable Project, develop in either host, inspect Context/Tickets and disable | App onboarding shell plus service/client composition; real smoke for each supported API route, plugin and executor. |
| L5 — measure value | Compare long tasks, handoff, repeated work, forgotten constraints and wrong cross-branch influence against current workflow | Existing downstream-value Ticket now depends on local integration and JudgeOps, not cloud launch. |
| Later — deployment and expansion | Team network/data service, optional remote Workers, hosted reliability and external connectors | Existing hosted/Worker/sync/release Tickets remain; refine only when their capability is selected. |

The first product checkpoint is bidirectional: A and B start from an explicit
shared Project base, work independently in their explorations, and receive
relevant changes in both directions. They can inspect, continue, defer or
explicitly adopt one result. Receiving/seeing a notice never changes governing
context. Source versions, branch-local hypotheses and adoption lineage remain
inspectable after restart and worktree deletion. Project overview is not main.

A local Agent retains native filesystem, shell and testing capabilities;
Tickets specify outcomes and constraints rather than a mandatory development
method. A ContextPackage assists ongoing work; an executable WorkRequest carries exact
inputs, registered tools and schemas, permitted actions and result receipts.
Background heavy jobs use the selected local subscription executor, independent
of a live interactive Session. For an interactive work request, no active Agent
or supported callback means pending/pull/next-turn delivery, not fabricated
completion. Developer Evidence and independent reviewer Outcome remain distinct.
Cloud Worker enrollment is not required to prove this loop.

## Newly separated Tickets

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml) | firm | None |
| [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml) | firm | None |
| [local-service-profile-v0](../../.vibehub/tickets/ticket-runtime-local-service-profile-v0.yaml) | firm | None — independently executable |
| [agent-work-request-contract-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-contract-v0.yaml) | firm | None — independently executable |
| [project-exploration-ux-v0](../../.vibehub/tickets/ticket-runtime-project-exploration-ux-v0.yaml) | firm | None |
| [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) | draft | [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml); [graph-store-v0](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml) |
| [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml) | draft | [agent-work-request-contract-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-contract-v0.yaml); [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) |
| [entity-extraction-v0](../../.vibehub/tickets/ticket-runtime-entity-extraction-v0.yaml) | draft | [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml); [local-codex-executor-v0](../../.vibehub/tickets/ticket-runtime-local-codex-executor-v0.yaml) |
| [entity-resolution-v0](../../.vibehub/tickets/ticket-runtime-entity-resolution-v0.yaml) | draft | [entity-extraction-v0](../../.vibehub/tickets/ticket-runtime-entity-extraction-v0.yaml); [judge-runtime-v0](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) |
| [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml) | draft | [query-engine-v0](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml); [session-delivery-v0](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml) |

## Delivery and splitting rules

- One Ticket owns an observable result and bounded verification/failure surface.
  Policy node types are operators, not automatically separate microservices.
- Refine existing draft Tickets in place after direct prerequisite Outcomes;
  do not repeat completed baselines or append fake successful Outcomes.
- Store, event, Graph, policy, requests and delivery own their schemas and fault
  tests. Integration composes them; the client does not reimplement decisions.
- Later deployment, source destinations and required host capabilities remain
  explicit. A probe may report an unsupported capability honestly; that does
  not pass a later acceptance criterion requiring actual live execution.
- New semantic acceptance revisions are append-only. Historical criteria,
  Evidence, Outcomes and causal dependencies remain readable.

## Runtime interaction contracts

| Boundary | Required behavior |
| --- | --- |
| Host → ingress | Actual measured units, enrolled scope, redaction, stable identity; durable inbox/outbox before ACK and crash-safe collection cursor. |
| Scope binding | Stable exploration and explicit repository/ref incarnation; worktree/Session are execution provenance, not global branch identity. |
| Policy → state | Pin input/policy/source versions; deterministic commands with durable idempotency and budgets; separate CAS rejection from admitted semantic conflict. |
| Policy → Agent task | Trusted instruction/tool/schema bundle, supported host admission and durable pending/claim/result/receipt; no implicit authority. |
| Graph → context | Selected shared background + own exploration + labeled relevant notices; current ACL before retrieval and delivery. |
| Awareness → adoption | Notice delivery, seeing and deferring do not mutate governing state; explicit adoption pins both ends and records provenance. |
| Code → semantics | Git ancestry/ref movement are source signals; code merge alone never approves all semantic changes. |
| Candidate → canonical | Explicit proposal, authority and expected versions; independent acceptance boundaries remain. |
| Local outage | Coding continues; pending work, gaps, stale views and recoverable cursors are visible. Full multi-device replication is later. |

## Retained hosted scope

The existing hosted platform selection, remote BYO enrollment/scheduler, cloud Codex adapter,
Worker recovery, hosted release/restore/capacity and online launch Tickets remain
as later capabilities. The release pipeline directly depends on the explicit
hosted platform decision; local auth/store do not. The measured local spike is
input to that decision, not a claim of deployment or production readiness.

The new local runner reuses existing job/request protocols; the later remote
transport must reuse its semantics rather than create another lifecycle.

GitHub/connectors, full offline multi-device semantic synchronization, compaction,
query/planning/canonicalization Workers and policy rollout remain independent
expansion work. No team hosting or Tailscale account changes are made here.

## Open details assigned to concrete work

Branch/ref incarnation and explicit clone/project aliases,
shared-base adoption behavior and Ticket attempt views are resolved by the scope
contract and UX Tickets. Collector event granularity and real injection/pull
capabilities are resolved by the host probe. First-version App enrollment requires Git and offers explicit initialization;
core project-only/multi-repo identities remain intact. Concrete local backend/start commands
are resolved by local profile; no new human approval is inferred for routine
engineering. Entity extraction/resolution thresholds are evaluated, not assumed.
These are testable uncertainties, not reasons to call the prototype ready.

## Workspace management and lifecycle follow-up

The owner also requires Ticket origin and completion locations plus Context
lifecycle/meaning/lineage. Product “workspace” currently means an execution work
area (checkout/worktree and its exploration binding); it must not silently reuse
the existing administrative Workspace entity. Exact terminology/mapping remains
part of the scope contract and UX verification.

- [Ticket workspace provenance](../../.vibehub/rooms/semantic-runtime/contract-runtime-ticket-workspace-provenance.yaml): immutable creation; append-only participation, execution completion, independent acceptance and delivery, pinned to their exact Ticket/Contract revisions. Old unknown origin is not guessed from file location.
- [Workspace visibility](../../.vibehub/rooms/semantic-runtime/intent-runtime-workspace-ticket-visibility.yaml): current-relevant and origin/participation/completion filters; hide/restore preferences separate from shared state or record deletion. An A-created Ticket active in B remains relevant to B, with permission-safe dependency blockers.
- [Context lifecycle and meaning](../../.vibehub/rooms/semantic-runtime/contract-runtime-context-lifecycle-lineage.yaml): semantic role, applicability, sources and reasons alongside lifecycle and exact parent lineage. Local supersession in A does not invalidate B; UI archive does not withdraw a governing constraint.

| New bounded Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Ticket workspace provenance](../../.vibehub/tickets/ticket-runtime-ticket-workspace-provenance-v0.yaml) | draft | [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml); [canonical-source-reader-v0](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) |
| [Context lifecycle/lineage](../../.vibehub/tickets/ticket-runtime-context-lifecycle-lineage-v0.yaml) | draft | [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) |

At the workspace-management checkpoint, the existing branch-scope contract supplied the identities; Project UX prototypes
the management journeys; Query consumes Context applicability/lifecycle; semantic
API exposes Ticket provenance and view preferences; the client composes those
APIs. These five Tickets gain append-only acceptance revisions. Query now also
depends on Context lifecycle; semantic API also depends on Ticket provenance.
The remaining new Tickets wait for their direct prerequisites and require
refinement; no current records are deleted or falsely completed by this plan.

Acceptance examples: Ticket created in A, executed in B and independently
accepted in C; later Contract/reopen preserves prior completion history; one
Ticket participates in two attempts; Context originates in A, is adopted by B,
and supersession in A leaves B's selected version explicit. Restart, duplicate
source events, unknown origin, worktree removal, revocation and hide/restore are
part of each domain's verification.

Independent follow-up validation passed for 2 new draft Tickets and 5 existing
revisions (30 active criteria): disposable apply, full graph, append-only
history, 14 resolved Context refs and authority guard. Validated batch SHA-256:
`06b6b2a3245b0092cbf886dd5d23f4498c4093cd1d7bad4e8bbdf01202ee9402`.
This is a plan update; workspace filters and lifecycle services are not yet built.

## Local App goal follow-up

The selected user journey is: launch local App → configure model API and local
executor → choose a Git folder (or explicitly initialize it) → inspect linked
worktrees → enable VibeHub for this Project → develop in Codex or Claude Code →
inspect captured Context/Tickets and background work → disable when desired.
A lightweight local UI is sufficient; native shell technology is not yet selected.

The App owns activation; plugins obey it. Project disable stops new capture,
model dispatch and injection and fences late results. It preserves historical
records and normal coding. Re-enable exposes capture gaps and an explicit backlog
choice; it does not silently import disabled-period conversations. Other Projects
remain independent. GitHub is an optional later connector, not an onboarding gate.

API provider credentials (OpenRouter, Vercel, TypeSafe) and CLI subscription login
(Codex, Claude) are separate settings and billing paths. Each route has measured
model capabilities and error behavior. The user chooses an executor; supporting
two choices does not require buying both subscriptions. Local Worker execution
still sends selected inputs to its model service. Worker events must not recurse
into the user-session Collector.

Tickets define outcomes, constraints, inputs and acceptance, not a required
coding method. Optional development skills remain composable. Internal maintenance
jobs still need precise input/tool/schema/result contracts, which do not dictate
how a developer must solve the project's Ticket.

[Primary interface research and local observations](local-app-integration-notes.md)
identify reusable SDKs and the actual CLI surfaces. They are capability evidence,
not successful live smoke tests. New Context records preserve the user's claims
and distinguish engineering interpretation from already implemented behavior.

| New bounded Ticket | Maturity | Responsibility |
| --- | --- | --- |
| [provider-settings-v0](../../.vibehub/tickets/ticket-runtime-provider-settings-v0.yaml) | firm | Explicit route/model configuration and local secure credential lifecycle. |
| [openrouter-judge-adapter-v0](../../.vibehub/tickets/ticket-runtime-openrouter-judge-adapter-v0.yaml) | firm | Reuse maintained evaluation adapter; prove mapping and failure semantics. |
| [git-project-enrollment-v0](../../.vibehub/tickets/ticket-runtime-git-project-enrollment-v0.yaml) | draft | Selected folder, explicit Git init, repository identity and external worktree discovery. |
| [project-activation-v0](../../.vibehub/tickets/ticket-runtime-project-activation-v0.yaml) | draft | Durable Project switch, admission fence and re-enable gaps. |
| [claude-host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-claude-host-capability-probe-v0.yaml) | firm | Actual Claude capture/query/lifecycle coverage, independently of Codex. |
| [local-worker-runner-v0](../../.vibehub/tickets/ticket-runtime-local-worker-runner-v0.yaml) | draft | Durable bounded local jobs, current source/access checks and proposal receipts. |
| [local-codex-executor-v0](../../.vibehub/tickets/ticket-runtime-local-codex-executor-v0.yaml) | draft | Codex CLI transport, login/health and real synthetic job. |
| [local-claude-executor-v0](../../.vibehub/tickets/ticket-runtime-local-claude-executor-v0.yaml) | draft | Claude CLI transport, login/health and real synthetic job. |
| [claude-host-adapter-v0](../../.vibehub/tickets/ticket-runtime-claude-host-adapter-v0.yaml) | draft | Installable Claude plugin consuming capture/query/delivery contracts. |
| [local-app-onboarding-v0](../../.vibehub/tickets/ticket-runtime-local-app-onboarding-v0.yaml) | draft | Local launch and actual provider/project/plugin/executor settings UI. |

Existing Codex probe/adapter, Git sensor, ingress, Judge, extraction, ingress policy,
session delivery, audit, UX and final service/client composition receive in-place
updates with append-only Acceptance histories. The mandatory extraction and audit
route moves from interactive-Agent work requests to local Worker jobs because
the requested product scope changed. The interactive bridge remains available as
a separate capability. The local runner owns the real WorkerNode handler, durable
Policy journal/outbox dispatch and new pinned-policy continuation after guarded
result admission; the existing non-model kernel is not mistaken for that
implementation. No completed implementation or benchmark is rerun or marked
successful by this planning change.

## Reading and executing this plan

The Ticket YAML files are the source of acceptance, dependencies and maturity.
The inventory below is a navigation/coverage index, not a second lifecycle.
For a selected Ticket, use its current Outcome and derived next action; append
Contract revisions when refinement changes the semantic obligation.

<!-- GENERATED-INVENTORY -->

## Plan inventory

The original industrial plan contained 54 Tickets. Its completed contracts and
spike remain valid history. The local-first checkpoint added 10 narrowly scoped Tickets and
revised 17 existing unfinished Tickets, preserving prior Acceptance/Contract
revisions. The workspace-management follow-up below adds two domain Tickets
and refines five existing Tickets. The App follow-up adds ten bounded Tickets and revises twelve existing Tickets.
The App planning checkpoint identified eight independent L0 Tickets. The local
bootstrap and OpenRouter adapter slices are now implemented; consult current
Outcomes and next actions for the remaining frontier. Older
identity/policy/observability foundations have already been delivered.

The tables below retain the original module inventory with updated direct
prerequisites. Later hosted and remote Worker groups are not prerequisites of the
local checkpoint; the newly separated local Worker path is now required. Ticket Outcomes and derived next actions, rather than this
navigation table, determine current scheduling.

### Contracts and bounded kernel

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Define tenant, project, repository, checkout, worktree, session, and source identities](../../.vibehub/tickets/ticket-runtime-scope-source-identity-v0.yaml) | firm | None |
| [Specify versioned raw and normalized event envelopes with immutable provenance](../../.vibehub/tickets/ticket-runtime-event-provenance-contract-v0.yaml) | firm | [Define tenant, project, repository, checkout, worktree, session, and source identities](../../.vibehub/tickets/ticket-runtime-scope-source-identity-v0.yaml) |
| [Define causal ordering, source cursors, freshness watermarks, and replay generations](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) | firm | [Specify versioned raw and normalized event envelopes with immutable provenance](../../.vibehub/tickets/ticket-runtime-event-provenance-contract-v0.yaml) |
| [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) | firm | [Define causal ordering, source cursors, freshness watermarks, and replay generations](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) |
| [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml) | firm | None |
| [Build the bounded Policy Graph execution kernel](../../.vibehub/tickets/ticket-runtime-policy-kernel-v0.yaml) | firm | [policy-artifacts-v0](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml); [define-semantic-context-protocol-v0](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) |
| [Define and verify the durable worker job protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) | firm | [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml); [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml) |
| [定义可观测性、SLO 与资源预算契约](../../.vibehub/tickets/ticket-runtime-observability-contract-v0.yaml) | firm | None |

### Platform, persistence and sources

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Produce online Runtime platform evaluation and synthetic spike](../../.vibehub/tickets/ticket-runtime-platform-evaluation-spike.yaml) | firm | [observability-contract-v0](../../.vibehub/tickets/ticket-runtime-observability-contract-v0.yaml); [worker-job-protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) |
| [选择具体 alpha 平台与部署边界](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) | firm | [platform-evaluation-spike](../../.vibehub/tickets/ticket-runtime-platform-evaluation-spike.yaml) |
| [Implement service identity, authorization, and tenant isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) | draft | [local-service-profile-v0](../../.vibehub/tickets/ticket-runtime-local-service-profile-v0.yaml) |
| [建立事务存储适配与 migration 基础](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) | draft | [service-auth-isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) |
| [Build durable idempotent event ingress with explicit ACK and delivery semantics](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) | draft | [store-schema-migrations](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml); [project-activation-v0](../../.vibehub/tickets/ticket-runtime-project-activation-v0.yaml) |
| [Model immutable Git commits and mutable ref movements as canonical provenance](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml) | firm | [causal-ordering-watermarks-v0](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) |
| [Implement non-blocking local Git and worktree observation](../../.vibehub/tickets/ticket-runtime-local-git-worktree-sensor-v0.yaml) | draft | [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml); [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml); [project-activation-v0](../../.vibehub/tickets/ticket-runtime-project-activation-v0.yaml) |
| [Implement the transactional Semantic Working Graph store](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml) | draft | [store-schema-migrations](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) |
| [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) | draft | [graph-store-v0](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml); [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) |

### Semantic computation and public APIs

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build bounded JudgeNode routing and fallback execution](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) | draft | [policy-kernel-v0](../../.vibehub/tickets/ticket-runtime-policy-kernel-v0.yaml); [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml); [provider-settings-v0](../../.vibehub/tickets/ticket-runtime-provider-settings-v0.yaml); [openrouter-judge-adapter-v0](../../.vibehub/tickets/ticket-runtime-openrouter-judge-adapter-v0.yaml); [project-activation-v0](../../.vibehub/tickets/ticket-runtime-project-activation-v0.yaml) |
| [Build durable PolicyRun journaling, idempotency, and crash resume](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml) | draft | [judge-runtime-v0](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) |
| [交付第一套可回放 ingress 业务 Policy](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml) | draft | [policy-journal-v0](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml); [entity-resolution-v0](../../.vibehub/tickets/ticket-runtime-entity-resolution-v0.yaml) |
| [读取并投影已有 canonical Git 记录](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) | draft | [git-commit-ref-provenance-v0](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml); [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Build point-in-time semantic retrieval and ranking](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) | draft | [judge-runtime-v0](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml); [canonical-source-reader-v0](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml); [context-lifecycle-lineage-v0](../../.vibehub/tickets/ticket-runtime-context-lifecycle-lineage-v0.yaml) |
| [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) | firm | [query-engine-v0](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) |
| [提供 Project / semantic reference / proposal 命令 API](../../.vibehub/tickets/ticket-runtime-semantic-api-v0.yaml) | draft | [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [canonical-git-bridge-v0](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml); [ticket-workspace-provenance-v0](../../.vibehub/tickets/ticket-runtime-ticket-workspace-provenance-v0.yaml) |
| [语义关系纠错与溯源](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml) | draft | [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) |
| [Define explicit proposal and compare-and-swap promotion into Git-backed canonical records](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) | draft | [reconciliation-worker-v0](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml); [canonical-source-reader-v0](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) |

### Later optional asynchronous reasoning workers

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Implement BYO worker enrollment and capability identity](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml) | draft | [service-auth-isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) |
| [Implement the durable multi-tenant Worker Scheduler](../../.vibehub/tickets/ticket-runtime-worker-scheduler.yaml) | draft | [byo-worker-enrollment](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml); [policy-journal-v0](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml) |
| [Implement job-scoped Context and Git materialization](../../.vibehub/tickets/ticket-runtime-worker-context-access.yaml) | draft | [byo-worker-enrollment](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml); [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) |
| [Implement worker result validation and Policy Graph resumption](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml) | draft | [worker-scheduler](../../.vibehub/tickets/ticket-runtime-worker-scheduler.yaml) |
| [实现 reconciliation job 的业务判断与输出契约](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml) | firm | [worker-job-protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) |
| [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml) | draft | [worker-context-access](../../.vibehub/tickets/ticket-runtime-worker-context-access.yaml); [worker-result-ingress](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml); [reconciliation-worker-v0](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml) |
| [Harden worker execution failure recovery](../../.vibehub/tickets/ticket-runtime-worker-failure-recovery.yaml) | draft | [codex-worker-adapter-probe](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml) |

### Consumer delivery and end-to-end slice

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Session registration 与可恢复 soft delivery](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml) | draft | [semantic-api-v0](../../.vibehub/tickets/ticket-runtime-semantic-api-v0.yaml); [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml) |
| [Codex host sensor / query adapter](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml) | draft | [session-delivery-v0](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml); [local-git-worktree-sensor-v0](../../.vibehub/tickets/ticket-runtime-local-git-worktree-sensor-v0.yaml); [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml) |
| [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | draft | [host-adapter-v0](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml); [ingress-policy-v0](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml); [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml); [semantic-feedback-v0](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml); [claude-host-adapter-v0](../../.vibehub/tickets/ticket-runtime-claude-host-adapter-v0.yaml); [local-claude-executor-v0](../../.vibehub/tickets/ticket-runtime-local-claude-executor-v0.yaml) |
| [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | draft | [ticket-build-semantic-runtime-service-v0](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml); [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml); [project-exploration-ux-v0](../../.vibehub/tickets/ticket-runtime-project-exploration-ux-v0.yaml); [local-app-onboarding-v0](../../.vibehub/tickets/ticket-runtime-local-app-onboarding-v0.yaml) |

### Local evidence and later hosted operations

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) | draft | [policy-journal-v0](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml); [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml); [canonical-git-bridge-v0](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml); [local-worker-runner-v0](../../.vibehub/tickets/ticket-runtime-local-worker-runner-v0.yaml) |
| [Establish Runtime telemetry, audit, budgets, and SLOs](../../.vibehub/tickets/ticket-runtime-telemetry-slo.yaml) | draft | [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml); [session-delivery-v0](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml) |
| [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) | draft | [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) |
| [执行 raw/derived/audit 保留与删除策略](../../.vibehub/tickets/ticket-runtime-retention-pruning-v0.yaml) | draft | [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) |
| [Build the reproducible service and worker release pipeline](../../.vibehub/tickets/ticket-runtime-release-pipeline.yaml) | draft | [build-semantic-collaboration-surface-v0](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml); [telemetry-slo](../../.vibehub/tickets/ticket-runtime-telemetry-slo.yaml); [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml); [select-semantic-runtime-alpha-platform](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) |
| [Prove backup, point-in-time recovery, and clean-environment restore](../../.vibehub/tickets/ticket-runtime-backup-restore.yaml) | draft | [release-pipeline](../../.vibehub/tickets/ticket-runtime-release-pipeline.yaml); [retention-pruning-v0](../../.vibehub/tickets/ticket-runtime-retention-pruning-v0.yaml) |
| [容量、故障隔离与 rollback staging 演练](../../.vibehub/tickets/ticket-runtime-staged-rollout-degradation.yaml) | draft | [worker-failure-recovery](../../.vibehub/tickets/ticket-runtime-worker-failure-recovery.yaml); [backup-restore](../../.vibehub/tickets/ticket-runtime-backup-restore.yaml) |
| [上线受保护的 internal alpha 并验证边界](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) | draft | [staged-rollout-degradation](../../.vibehub/tickets/ticket-runtime-staged-rollout-degradation.yaml) |

### Later expansion (downstream study now runs after the local checkpoint)

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Implement resumable offline local-to-cloud event and semantic-state synchronization](../../.vibehub/tickets/ticket-runtime-local-cloud-sync-v0.yaml) | draft | [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Define a connector substrate for webhook, polling, backfill, lifecycle, and quota handling](../../.vibehub/tickets/ticket-runtime-connector-substrate-v0.yaml) | draft | [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Implement GitHub repository, push, ref, pull-request, review, check, and permission ingestion](../../.vibehub/tickets/ticket-runtime-github-connector-v0.yaml) | draft | [connector-substrate-v0](../../.vibehub/tickets/ticket-runtime-connector-substrate-v0.yaml); [git-commit-ref-provenance-v0](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml) |
| [Build Policy shadowing, activation, canary, and rollback](../../.vibehub/tickets/ticket-runtime-policy-rollout-v0.yaml) | draft | [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [Build semantic compaction as an independent Context consumer](../../.vibehub/tickets/ticket-runtime-compaction-v0.yaml) | draft | [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [复杂 query 的异步 synthesis worker](../../.vibehub/tickets/ticket-runtime-query-synthesis-worker-v0.yaml) | draft | [codex-worker-adapter-probe](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [发现可独立执行工作的 planning proposal worker](../../.vibehub/tickets/ticket-runtime-planning-worker-v0.yaml) | draft | [codex-worker-adapter-probe](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [把 validated candidates 综合成 canonical proposal](../../.vibehub/tickets/ticket-runtime-canonicalization-worker-v0.yaml) | draft | [codex-worker-adapter-probe](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [真实任务受控下游收益评测](../../.vibehub/tickets/ticket-runtime-downstream-value-v0.yaml) | draft | [build-semantic-runtime-service-v0](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml); [judgeops-v0](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |

## Historical replacement of the five broad Contracts

The following table records the earlier V1-to-V2 split for historical explanation;
current local-first responsibilities and dependencies are in the Ticket YAML and
stages above. All five IDs and Contract V1 histories remain readable. Their V1 Acceptance
revisions are retired, not deleted or marked achieved. Contract V2 selects
only the new bounded obligations; same-Ticket splits cite exact derived_from
references. Cross-Ticket responsibility transfers are recorded below because
the Acceptance lineage schema is local to a Ticket. No successful Outcome
is fabricated to hide or archive old work.

| Existing Ticket | Current bounded responsibility | Obligations moved to separate Tickets |
| --- | --- | --- |
| [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) | Executable Working Graph revisions/assertions/snapshots/conflicts | Scope identity → identity; causal ordering → watermark contract; external canonical writes → canonical Git bridge. |
| [Platform choice](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) | Hosted platform decision | Evaluation/spike and later deployment implementation are separate. |
| [Service composition](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | Integration of delivered modules | Ingress, store, policy, query/compiler and host adapters own implementation. |
| [Client surface](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | Consume actual APIs in a reviewable UI | Audit, semantic APIs and service composition are independent prerequisites. |
| [Hosted launch](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) | Bounded internal hosted rollout | Release, recovery, capacity and degradation checks own their verification. |


Dependencies of the five revised Tickets change because their actual outcomes
and required inputs changed. The old broad protocol/platform→service→surface→launch
sequence is preserved in Contract V1 and Git history, not kept as false scheduling
edges after the split. New edges name the direct artifact or decision required.
No completed provider/benchmark Ticket is added as an artificial prerequisite.

## Architecture coverage

| Design responsibility | Owning Ticket boundaries |
| --- | --- |
| Tech Design §§6–8,20,25: planes, sources, identity | Identity; event/provenance; watermark; ingress; Git object/ref and worktree adapters. |
| §§9,11: actual policy computation | Artifact schema/compiler; execution kernel; bounded JudgeNode; durable journal; concrete ingress business graph. |
| §§10,19: semantic state and concurrency | Working Graph contract/store; source invalidation; semantic commands; explicit canonical bridge. |
| §§12–13: retrieval and compiler | Authorized candidate/rank pipeline; reproducible bounded ContextPackage; public query API. |
| §14: selective reasoning | Existing job/request contracts → local runner → separate Codex/Claude subscription executors → extraction and validated proposal admission. Remote enrollment/scheduler/context/result and specialized bundles remain later; no automatic Outcome acceptance. |
| §§15–17,26: host delivery and compaction | Session delivery with activation fencing; independently observed Codex and Claude capabilities; later checkpoint compaction; no default hard injection in initial alpha. |
| §§18,21–22: persistence, connectors and security | Store/migrations; service auth; source access; retention; connector conformance and GitHub in later expansion. |
| §§23–24: observability and failure | Early correlation/SLI/budget contract; module failure tests; audit/telemetry; worker recovery; staging capacity and outage drills. |
| §§27,30: evaluation and rollout gates | JudgeOps frozen replay/regression; controlled downstream study; policy rollout; technical alpha does not satisfy unmeasured product-value gates. |
| §7 and §§28–31: deployment and migration | Platform comparison/owner selection; isolated release; restore; bounded local buffer for alpha; full local/cloud sync later. |

## Acceptance and release interpretation

Protocol/kernel acceptance proves schemas and executable behavior against
conformance fixtures; it does not claim a cloud service exists. Platform-specific
Tickets remain draft where target/adapter choices determine exact tests.
During refinement every requested external model destination, host capability,
numeric SLO and release command must be grounded in observed support and the
owner-selected environment.

The first active ingress policy is pinned in the release manifest and passes
offline regression gates. Full online policy canary/shadow administration is a
later Ticket; deployment rollback provides the initial version switch.
Compaction and hard injection remain unavailable by default until their
capability-specific tests and host boundaries are established.

Critical failure evidence includes pre/post-ACK crash, duplicate/reordered event,
transaction interruption, stale Graph/worker result, expired lease, revocation
before retrieval and delivery, model quota exhaustion, noisy-tenant backpressure,
restore of in-flight jobs, and compatibility across rollback. Tests belong to
the module that owns the invariant; operational drills verify their composition.

The concrete workload and numerical engineering targets are delivered by the
observability-contract Ticket, consumed by platform evaluation and capacity
rehearsal, and never retroactively weakened to turn a failure into a pass.
This plan establishes responsibility for industrial reliability; it does not
claim those reliability properties have already been implemented or measured.

A capability inventory may report unsupported mechanisms; every later Ticket requiring a live host/Agent roundtrip must still prove that roundtrip. The optional cloud Codex adapter no longer gates the local checkpoint, but an unavailable executor cannot pass its own live-job criterion or a hosted release that requires it.

## Historical planning validation

Two independent read-only reviews passed the final 54-Ticket candidate: one
checked contracts, history, Context, dependencies and maturity; the other checked
architecture coverage, business ownership, Git/worker failure paths and operational
acceptance. Candidate SHA-256:
`24a833ed718f17e627e1f7fd9dc14ec1176e3bed0e34b18ee1432d46617f5e17`.
The batch contains 13 firm and 41 draft Tickets, with 197 active criteria.
This validates the plan only; execution Evidence and independent Outcomes remain
future work. Concrete environment mechanisms and capability probes are recorded
as refinement work, not extra human approval gates.


## Local-first checkpoint validation (c49b6f7)

The local-first replan adds 10 bounded Tickets and revises 17 existing unfinished
Tickets. Successful implementation Outcomes and original design drafts are
unchanged. The exact 27-Ticket candidate passed independent semantic/dependency review,
disposable apply, schema and immutable-history validation. Its 20 Context refs
resolved through the shared engine and authority guard passed. The local L4
dependency closure contains 36 Tickets with no hosted platform, persistent
Worker scheduler/Codex adapter, online launch or P2P prerequisite.

Validated batch SHA-256:
`ca6ebb2eca4b727d0596ff90dc3416dad879d2398464d4b3dee9ef3e7e76be7b`.
This validates planning and provenance, not execution or product readiness.

## Local App checkpoint validation

The App follow-up adds 10 bounded Tickets and revises 12 existing unfinished
Tickets, retaining Acceptance/Contract histories. Eight new Context claims record
the goal; the earlier no-background-Worker delivery assumption is superseded.
Independent review passed the exact 22-Ticket batch (82 active criteria),
disposable apply/project validation, all 28 resolved refs and Context guard.

The service/client dependency closures contain 46/50 Tickets respectively and
require neither the interactive Agent bridge nor the remote Worker scheduler or
hosted platform decision. The local runner explicitly owns real Policy WorkerNode
dispatch and guarded result continuation; ingress policy composes it. Module
criteria own activation checks in ingress, Judge, Worker and session delivery.

Validated batch SHA-256:
`f5f91b16b0e6ca14d036355e04edafa483a2d129709fad63a18eee72c2fbce7d`.
This turn changes planning and research records only. No app, plugin or Worker
was installed, no credential was inspected and no live model call was made.
