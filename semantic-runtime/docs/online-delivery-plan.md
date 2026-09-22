# Semantic Runtime: local experience and later online delivery

Status: revised product direction and planned work, not implemented service behavior.
Baseline: 2026-09-21, current implementation checkpoint f10a055.

## Current direction and source of truth

The original [PRD](02_prd_vibehub_semantic_runtime.md) and
[Tech Design](03_tech_design_semantic_runtime.md) remain unchanged proposed drafts.
This plan preserves their Policy Graph, Semantic Working Graph, ingress, query,
Context Compiler, source/canonical separation and selective reasoning architecture.
It updates delivery order and the exploration/awareness product model from the
owner's subsequent discussion. Durable decisions live in the shared Room:

- [Local useful loop before cloud or a persistent Worker](../../.vibehub/rooms/semantic-runtime/decision-runtime-local-experience-first.yaml).
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
service and a persistent independent reasoning Worker are not selected by this
plan. Local processing may still call an authorized external model; local service
placement does not mean all inference or every data destination is local.

## Current readiness

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
request delivery, bidirectional awareness and the new local client. Address
resolution is not semantic entity resolution. Same-entity concurrent assertions
in the current one-lineage Graph are not branch-local hypotheses.

## Delivery sequence

| Stage | User-visible or engineering outcome | Work |
| --- | --- | --- |
| L0 — close the important unknowns | Stable exploration contract, observed host coverage, runnable local profile, executable request contract, reviewable Project UX | The five new firm Tickets below can run independently. |
| L1 — reliable local state | Authenticate local clients; durably accept events; version/migrate Graph state; isolate explorations; retain exact source and access history | Reuse existing auth/store/ingress/Graph/invalidation/Git Tickets plus branch projection. |
| L2 — actual semantic write path | Current Agent can receive a tool-bearing request and return a cited proposal; extract typed claims, resolve entities and execute the concrete policy | Request bridge → extraction → resolution → ingress policy, with bounded Judge and durable policy journal. |
| L3 — useful reads and awareness | Compile scoped Context, capture real host units, recover notices, expose A→B→A without implicit adoption | Existing query/compiler/API/session/host Tickets, new branch awareness, audit and telemetry. |
| L4 — usable local client | Real local capture-to-context loop and Project/exploration/Room UI; multiple Sessions and one Ticket in two explorations | Existing service and collaboration-surface Tickets revised in place. |
| L5 — measure value | Compare long tasks, handoff, repeated work, forgotten constraints and wrong cross-branch influence against current workflow | Existing downstream-value Ticket now depends on local integration and JudgeOps, not cloud launch. |
| Later — deployment and expansion | Team network/data service, optional persistent Workers, hosted reliability and external connectors | Existing hosted/Worker/sync/release Tickets remain; refine only when their capability is selected. |

The first product checkpoint is bidirectional: A and B start from an explicit
shared Project base, work independently in their explorations, and receive
relevant changes in both directions. They can inspect, continue, defer or
explicitly adopt one result. Receiving/seeing a notice never changes governing
context. Source versions, branch-local hypotheses and adoption lineage remain
inspectable after restart and worktree deletion. Project overview is not main.

A local Agent retains native filesystem, shell and testing capabilities. A
ContextPackage assists ongoing work; an executable WorkRequest carries exact
inputs, registered tools and schemas, permitted actions and result receipts.
No active Agent or unsupported callback means pending/pull/next-turn delivery,
not fabricated completion. Developer Evidence and independent reviewer Outcome
remain distinct. Cloud Worker enrollment is not required to prove this loop.

## Newly separated Tickets

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml) | firm | None — independently executable |
| [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml) | firm | None — independently executable |
| [local-service-profile-v0](../../.vibehub/tickets/ticket-runtime-local-service-profile-v0.yaml) | firm | None — independently executable |
| [agent-work-request-contract-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-contract-v0.yaml) | firm | None — independently executable |
| [project-exploration-ux-v0](../../.vibehub/tickets/ticket-runtime-project-exploration-ux-v0.yaml) | firm | None — independently executable |
| [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) | draft | [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml); [graph-store-v0](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml) |
| [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml) | draft | [agent-work-request-contract-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-contract-v0.yaml); [host-capability-probe-v0](../../.vibehub/tickets/ticket-runtime-host-capability-probe-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) |
| [entity-extraction-v0](../../.vibehub/tickets/ticket-runtime-entity-extraction-v0.yaml) | draft | [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml); [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) |
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

The existing platform selection, BYO enrollment, scheduler, cloud Codex adapter,
Worker recovery, hosted release/restore/capacity and online launch Tickets remain
as later capabilities. The release pipeline directly depends on the explicit
hosted platform decision; local auth/store do not. The measured local spike is
input to that decision, not a claim of deployment or production readiness.

GitHub/connectors, full offline multi-device semantic synchronization, compaction,
query/planning/canonicalization Workers and policy rollout remain independent
expansion work. No team hosting or Tailscale account changes are made here.

## Open details assigned to concrete work

Branch/ref incarnation and alias enrollment, project-only/non-Git exploration,
shared-base adoption behavior and Ticket attempt views are resolved by the scope
contract and UX Tickets. Collector event granularity and real injection/pull
capabilities are resolved by the host probe. Concrete local backend/start commands
are resolved by local profile; no new human approval is inferred for routine
engineering. Entity extraction/resolution thresholds are evaluated, not assumed.
These are testable uncertainties, not reasons to call the prototype ready.

## Reading and executing this plan

The Ticket YAML files are the source of acceptance, dependencies and maturity.
The inventory below is a navigation/coverage index, not a second lifecycle.
For a selected Ticket, use its current Outcome and derived next action; append
Contract revisions when refinement changes the semantic obligation.

<!-- GENERATED-INVENTORY -->

## Plan inventory

The original industrial plan contained 54 Tickets. Its completed contracts and
spike remain valid history. This replan adds 10 narrowly scoped Tickets and
revises 17 existing unfinished Tickets, preserving prior Acceptance/Contract
revisions. The five L0 Tickets above are the current new executable frontier;
older identity/policy/observability foundations have already been delivered.

The tables below retain the original module inventory with updated direct
prerequisites. Later hosted and Worker groups are not prerequisites of the
local checkpoint. Ticket Outcomes and derived next actions, rather than this
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
| [Build durable idempotent event ingress with explicit ACK and delivery semantics](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) | draft | [store-schema-migrations](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) |
| [Model immutable Git commits and mutable ref movements as canonical provenance](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml) | firm | [causal-ordering-watermarks-v0](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) |
| [Implement non-blocking local Git and worktree observation](../../.vibehub/tickets/ticket-runtime-local-git-worktree-sensor-v0.yaml) | draft | [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml); [branch-scope-contract-v0](../../.vibehub/tickets/ticket-runtime-branch-scope-contract-v0.yaml) |
| [Implement the transactional Semantic Working Graph store](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml) | draft | [store-schema-migrations](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) |
| [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) | draft | [graph-store-v0](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml); [durable-ingress-v0](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) |

### Semantic computation and public APIs

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build bounded JudgeNode routing and fallback execution](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) | draft | [policy-kernel-v0](../../.vibehub/tickets/ticket-runtime-policy-kernel-v0.yaml); [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) |
| [Build durable PolicyRun journaling, idempotency, and crash resume](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml) | draft | [judge-runtime-v0](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) |
| [交付第一套可回放 ingress 业务 Policy](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml) | draft | [policy-journal-v0](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml); [entity-resolution-v0](../../.vibehub/tickets/ticket-runtime-entity-resolution-v0.yaml) |
| [读取并投影已有 canonical Git 记录](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) | draft | [git-commit-ref-provenance-v0](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml); [source-access-invalidation-v0](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Build point-in-time semantic retrieval and ranking](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) | draft | [judge-runtime-v0](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml); [canonical-source-reader-v0](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml); [branch-graph-projection-v0](../../.vibehub/tickets/ticket-runtime-branch-graph-projection-v0.yaml) |
| [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) | firm | [query-engine-v0](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) |
| [提供 Project / semantic reference / proposal 命令 API](../../.vibehub/tickets/ticket-runtime-semantic-api-v0.yaml) | draft | [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [canonical-git-bridge-v0](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) |
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
| [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | draft | [host-adapter-v0](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml); [ingress-policy-v0](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml); [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml); [semantic-feedback-v0](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml); [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml) |
| [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | draft | [build-semantic-runtime-service-v0](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml); [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml); [project-exploration-ux-v0](../../.vibehub/tickets/ticket-runtime-project-exploration-ux-v0.yaml) |

### Local evidence and later hosted operations

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) | draft | [policy-journal-v0](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml); [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml); [context-compiler-v0](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml); [canonical-git-bridge-v0](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) |
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
| [选择具体 alpha 平台与部署边界](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) | firm | [platform-evaluation-spike](../../.vibehub/tickets/ticket-runtime-platform-evaluation-spike.yaml) |
| [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | draft | [host-adapter-v0](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml); [ingress-policy-v0](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml); [branch-awareness-v0](../../.vibehub/tickets/ticket-runtime-branch-awareness-v0.yaml); [semantic-feedback-v0](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml); [agent-work-request-bridge-v0](../../.vibehub/tickets/ticket-runtime-agent-work-request-bridge-v0.yaml) |
| [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | draft | [build-semantic-runtime-service-v0](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml); [decision-audit-v0](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml); [project-exploration-ux-v0](../../.vibehub/tickets/ticket-runtime-project-exploration-ux-v0.yaml) |
| [上线受保护的 internal alpha 并验证边界](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) | draft | [staged-rollout-degradation](../../.vibehub/tickets/ticket-runtime-staged-rollout-degradation.yaml) |

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
| §14: selective reasoning | Job protocol; enrollment/scheduler/context/result; reconciliation bundle; Codex adapter; later query/planning/canonicalization bundles. Canonicalization synthesis feeds the deterministic bridge; no automatic Outcome acceptance. |
| §§15–17,26: host delivery and compaction | Session delivery; observed Codex capabilities; later checkpoint compaction; no default hard injection in initial alpha. |
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


## Current planning validation

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
