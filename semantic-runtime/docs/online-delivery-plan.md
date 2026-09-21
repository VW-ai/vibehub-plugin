# Semantic Runtime: online delivery plan

Status: planned work, not implemented service behavior. Baseline: 2026-09-21.

## Product and architecture baseline

The owner asked for an industrial service plan, with independently verifiable
Tickets spanning business behavior, engineering, maintainability and operations.
The primary design is [Tech Design](03_tech_design_semantic_runtime.md), supported
by the [PRD](02_prd_vibehub_semantic_runtime.md). Those proposed documents remain
unchanged. This plan turns their boxes and interaction boundaries into executable
outcomes; it does not replace the Policy Graph with a Context CRUD service.

The runtime flow is source/host adapters → durable Event Gateway → mechanical
Normalizer/ACL → Policy Graph ↔ SemanticJudge and Semantic Working Graph →
Worker when needed / retrieval and Context Compiler → consumer delivery.
Raw events, derived semantic state, and canonical truth remain separate planes.
Project is a semantic scope with multiple repository memberships. Git remains
code/artifact truth. Stable logical references and exact immutable revisions
apply to derived objects and canonical references without deciding cloud ownership
of all canonical project records.

The previous quick-alpha intention remains a priority to expose a useful slice
early, not a promised two-day date or permission to omit durability and isolation.
The recent Context/version/proposal discussion refines concurrency and addressability
inside the original architecture. It does not supersede policy execution,
retrieval, Context compilation, selective workers, or the local outage boundary.

## Delivery and splitting rules

- Each Ticket owns an observable outcome and a bounded test/failure surface.
  Independent retry, verification, authority or scheduling boundaries justify a split.
- A Policy node type is an operator in the executor, not automatically a microservice
  or a separate Ticket. Process topology is selected after its workload is explicit.
- Shared protocol Tickets deliver versioned schemas, executable validators/pure
  transitions or conformance fixtures, plus documented invariants. Prose alone is
  insufficient when a firm criterion promises executable behavior.
- Implementation Tickets consume those artifacts through public interfaces.
  Core modules remain independent of model provider, store and host.
- Draft Tickets contain bounded direction and failure cases; they enter REFINE
  after dependencies close, then gain concrete commands, workloads, numeric gates
  and a firm contract. A draft is not an execution-ready checklist.
- Direct dependencies identify required artifacts or decisions. Completed replay,
  JEV adapters and Peel benchmarks are Context, not repeated development stages.
- Every behavior Ticket includes relevant failure checks and audit consequences;
  dedicated operational Tickets own cross-cutting instrumentation and service drills.

## Runtime interaction contracts

The following are proposed implementation requirements to be resolved by the
owning Tickets, not claims that the current code already provides them.

| Boundary | Required behavior |
| --- | --- |
| Source → Gateway | Authenticate and validate, then durably persist inbox plus outbox before ACK; retries retain logical identity. |
| Ledger → Policy | At-least-once delivery with idempotent effects; pin policy/input revisions and source watermarks. |
| Policy nodes | Explicit input/output schemas, join/error/deadline/budget semantics, resumable state and immutable audits. |
| Policy → Graph / jobs | Commit derived mutation and durable dispatch intent consistently; retry never duplicates effects. |
| WorkerNode → scheduler | Submit a durable job and yield. Do not await a long reasoning run inside ordinary ingestion. |
| Worker → Runtime | Structured result re-enters validation/policy with attempt fencing, input versions, ACL, freshness and authority checks. |
| Graph → compiler | Read a defined snapshot; preserve provenance, unresolved conflict and freshness under a hard token budget. |
| Compiler → session | Quiet query/soft pointers first; recheck access, deduplicate and resume delivery; no assumed host callback capability. |
| Candidate → canonical | Explicit proposal and authority plus expected version/Git base checks; never implicit last-write-wins. |
| Local → cloud | Bounded buffering and visible gaps; coding continues through cloud failure; full replication is a later capability. |

## Alpha boundary and later expansion

The protected internal alpha must prove a real Git/Agent → Policy → working-state
→ compiled Context/soft pointer loop, including one asynchronous worker path and
observable concurrent conflict. It also needs scoped access, durable acceptance,
restart safety, bounded rate/queue behavior, useful diagnostics and a verified
restore/rollback procedure. A synthetic rehearsal establishes engineering behavior;
private project data and actual provider destinations still require their own
authorization. Existing Peel-to-TypeSafe permission is not a blanket source grant.

GitHub webhook/backfill, general external connectors, full local/cloud derived-state
synchronization, checkpoint compaction and the controlled downstream-value study
are separately scheduled expansion work. They do not all block the first internal
alpha. Broad public/enterprise rollout remains subject to the PRD's value, trust,
reliability and source-control gates; an internal alpha is not proof of those gates.

The owner's cloud Codex machine is a proposed private BYO reasoning executor.
Its supported execution/auth/protocol/cancellation capabilities must be inspected
and smoke-tested during its adapter Ticket. Account credentials remain on that
machine; the Runtime uses a scoped worker identity. Personal subscription capacity
is measured as available quota/concurrency, never assumed unlimited or suitable
as a shared tenant pool. Worker results carry no extra truth authority.

## Reading and executing this plan

The Ticket YAML files are the source of acceptance, dependencies and maturity.
The inventory below is a navigation/coverage index, not a second lifecycle.
For a selected Ticket, use its current Outcome and derived next action; append
Contract revisions when refinement changes the semantic obligation.

<!-- GENERATED-INVENTORY -->

## Plan inventory

This revision contains 54 Tickets: 49 new and 5 append-only
Contract V2 revisions. At planning time: 3 READY, 51 BLOCKED.
Nine post-alpha Tickets are outside the initial launch dependency closure.
The remaining Tickets form the protected-alpha path; this is not one sprint
or a two-day delivery promise. Groups are ownership/navigation, not execution stages.
Dependencies and current Outcomes govern actual scheduling.

Three immediate outcomes can proceed independently:

- [Define tenant, project, repository, checkout, worktree, session, and source identities](../../.vibehub/tickets/ticket-runtime-scope-source-identity-v0.yaml) — EXECUTE.
- [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml) — EXECUTE.
- [定义可观测性、SLO 与资源预算契约](../../.vibehub/tickets/ticket-runtime-observability-contract-v0.yaml) — EXECUTE.

### Contracts and bounded kernel

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Define tenant, project, repository, checkout, worktree, session, and source identities](../../.vibehub/tickets/ticket-runtime-scope-source-identity-v0.yaml) | firm | None |
| [Specify versioned raw and normalized event envelopes with immutable provenance](../../.vibehub/tickets/ticket-runtime-event-provenance-contract-v0.yaml) | firm | [Define tenant, project, repository, checkout, worktree, session, and source identities](../../.vibehub/tickets/ticket-runtime-scope-source-identity-v0.yaml) |
| [Define causal ordering, source cursors, freshness watermarks, and replay generations](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) | firm | [Specify versioned raw and normalized event envelopes with immutable provenance](../../.vibehub/tickets/ticket-runtime-event-provenance-contract-v0.yaml) |
| [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) | firm | [Define causal ordering, source cursors, freshness watermarks, and replay generations](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) |
| [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml) | firm | None |
| [Build the bounded Policy Graph execution kernel](../../.vibehub/tickets/ticket-runtime-policy-kernel-v0.yaml) | firm | [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml); [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) |
| [Define and verify the durable worker job protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) | firm | [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml); [Build the versioned Policy Graph artifact registry and compiler](../../.vibehub/tickets/ticket-runtime-policy-artifacts-v0.yaml) |
| [定义可观测性、SLO 与资源预算契约](../../.vibehub/tickets/ticket-runtime-observability-contract-v0.yaml) | firm | None |

### Platform, persistence and sources

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Produce online Runtime platform evaluation and synthetic spike](../../.vibehub/tickets/ticket-runtime-platform-evaluation-spike.yaml) | firm | [定义可观测性、SLO 与资源预算契约](../../.vibehub/tickets/ticket-runtime-observability-contract-v0.yaml); [Define and verify the durable worker job protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) |
| [选择具体 alpha 平台与部署边界](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) | firm | [Produce online Runtime platform evaluation and synthetic spike](../../.vibehub/tickets/ticket-runtime-platform-evaluation-spike.yaml) |
| [Implement service identity, authorization, and tenant isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) | draft | [选择具体 alpha 平台与部署边界](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) |
| [建立事务存储适配与 migration 基础](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) | draft | [Implement service identity, authorization, and tenant isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) |
| [Build durable idempotent event ingress with explicit ACK and delivery semantics](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) | draft | [建立事务存储适配与 migration 基础](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) |
| [Model immutable Git commits and mutable ref movements as canonical provenance](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml) | firm | [Define causal ordering, source cursors, freshness watermarks, and replay generations](../../.vibehub/tickets/ticket-runtime-causal-ordering-watermarks-v0.yaml) |
| [Implement non-blocking local Git and worktree observation](../../.vibehub/tickets/ticket-runtime-local-git-worktree-sensor-v0.yaml) | draft | [Build durable idempotent event ingress with explicit ACK and delivery semantics](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) |
| [Implement the transactional Semantic Working Graph store](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml) | draft | [建立事务存储适配与 migration 基础](../../.vibehub/tickets/ticket-runtime-store-schema-migrations.yaml) |
| [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) | draft | [Implement the transactional Semantic Working Graph store](../../.vibehub/tickets/ticket-runtime-graph-store-v0.yaml); [Build durable idempotent event ingress with explicit ACK and delivery semantics](../../.vibehub/tickets/ticket-runtime-durable-ingress-v0.yaml) |

### Semantic computation and public APIs

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build bounded JudgeNode routing and fallback execution](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) | draft | [Build the bounded Policy Graph execution kernel](../../.vibehub/tickets/ticket-runtime-policy-kernel-v0.yaml); [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Build durable PolicyRun journaling, idempotency, and crash resume](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml) | draft | [Build bounded JudgeNode routing and fallback execution](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml) |
| [交付第一套可回放 ingress 业务 Policy](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml) | draft | [Implement the durable multi-tenant Worker Scheduler](../../.vibehub/tickets/ticket-runtime-worker-scheduler.yaml) |
| [读取并投影已有 canonical Git 记录](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) | draft | [Model immutable Git commits and mutable ref movements as canonical provenance](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml); [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Build point-in-time semantic retrieval and ranking](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) | draft | [Build bounded JudgeNode routing and fallback execution](../../.vibehub/tickets/ticket-runtime-judge-runtime-v0.yaml); [读取并投影已有 canonical Git 记录](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) |
| [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) | firm | [Build point-in-time semantic retrieval and ranking](../../.vibehub/tickets/ticket-runtime-query-engine-v0.yaml) |
| [提供 Project / semantic reference / proposal 命令 API](../../.vibehub/tickets/ticket-runtime-semantic-api-v0.yaml) | draft | [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [Define explicit proposal and compare-and-swap promotion into Git-backed canonical records](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) |
| [语义关系纠错与溯源](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml) | draft | [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) |
| [Define explicit proposal and compare-and-swap promotion into Git-backed canonical records](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) | draft | [实现 reconciliation job 的业务判断与输出契约](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml); [读取并投影已有 canonical Git 记录](../../.vibehub/tickets/ticket-runtime-canonical-source-reader-v0.yaml) |

### Asynchronous reasoning workers

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Implement BYO worker enrollment and capability identity](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml) | draft | [Implement service identity, authorization, and tenant isolation](../../.vibehub/tickets/ticket-runtime-service-auth-isolation.yaml) |
| [Implement the durable multi-tenant Worker Scheduler](../../.vibehub/tickets/ticket-runtime-worker-scheduler.yaml) | draft | [Implement BYO worker enrollment and capability identity](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml); [Build durable PolicyRun journaling, idempotency, and crash resume](../../.vibehub/tickets/ticket-runtime-policy-journal-v0.yaml) |
| [Implement job-scoped Context and Git materialization](../../.vibehub/tickets/ticket-runtime-worker-context-access.yaml) | draft | [Implement BYO worker enrollment and capability identity](../../.vibehub/tickets/ticket-runtime-byo-worker-enrollment.yaml); [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml) |
| [Implement worker result validation and Policy Graph resumption](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml) | draft | [Implement the durable multi-tenant Worker Scheduler](../../.vibehub/tickets/ticket-runtime-worker-scheduler.yaml) |
| [实现 reconciliation job 的业务判断与输出契约](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml) | firm | [Define and verify the durable worker job protocol](../../.vibehub/tickets/ticket-runtime-worker-job-protocol.yaml) |
| [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml) | draft | [Implement job-scoped Context and Git materialization](../../.vibehub/tickets/ticket-runtime-worker-context-access.yaml); [Implement worker result validation and Policy Graph resumption](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml); [实现 reconciliation job 的业务判断与输出契约](../../.vibehub/tickets/ticket-runtime-reconciliation-worker-v0.yaml) |
| [Harden worker execution failure recovery](../../.vibehub/tickets/ticket-runtime-worker-failure-recovery.yaml) | draft | [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml) |

### Consumer delivery and end-to-end slice

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Session registration 与可恢复 soft delivery](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml) | draft | [提供 Project / semantic reference / proposal 命令 API](../../.vibehub/tickets/ticket-runtime-semantic-api-v0.yaml); [Implement worker result validation and Policy Graph resumption](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml) |
| [Codex host sensor / query adapter](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml) | draft | [Session registration 与可恢复 soft delivery](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml); [Implement non-blocking local Git and worktree observation](../../.vibehub/tickets/ticket-runtime-local-git-worktree-sensor-v0.yaml) |
| [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | draft | [Codex host sensor / query adapter](../../.vibehub/tickets/ticket-runtime-host-adapter-v0.yaml); [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [语义关系纠错与溯源](../../.vibehub/tickets/ticket-runtime-semantic-feedback-v0.yaml); [交付第一套可回放 ingress 业务 Policy](../../.vibehub/tickets/ticket-runtime-ingress-policy-v0.yaml) |
| [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | draft | [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml); [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) |

### Evidence, operations and protected launch

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) | draft | [Implement worker result validation and Policy Graph resumption](../../.vibehub/tickets/ticket-runtime-worker-result-ingress.yaml); [Build reproducible consumer-specific Context compilation](../../.vibehub/tickets/ticket-runtime-context-compiler-v0.yaml); [Define explicit proposal and compare-and-swap promotion into Git-backed canonical records](../../.vibehub/tickets/ticket-runtime-canonical-git-bridge-v0.yaml) |
| [Establish Runtime telemetry, audit, budgets, and SLOs](../../.vibehub/tickets/ticket-runtime-telemetry-slo.yaml) | draft | [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml); [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [Session registration 与可恢复 soft delivery](../../.vibehub/tickets/ticket-runtime-session-delivery-v0.yaml) |
| [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) | draft | [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) |
| [执行 raw/derived/audit 保留与删除策略](../../.vibehub/tickets/ticket-runtime-retention-pruning-v0.yaml) | draft | [Build end-to-end semantic decision audit and explanation](../../.vibehub/tickets/ticket-runtime-decision-audit-v0.yaml) |
| [Build the reproducible service and worker release pipeline](../../.vibehub/tickets/ticket-runtime-release-pipeline.yaml) | draft | [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml); [Establish Runtime telemetry, audit, budgets, and SLOs](../../.vibehub/tickets/ticket-runtime-telemetry-slo.yaml); [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [Prove backup, point-in-time recovery, and clean-environment restore](../../.vibehub/tickets/ticket-runtime-backup-restore.yaml) | draft | [Build the reproducible service and worker release pipeline](../../.vibehub/tickets/ticket-runtime-release-pipeline.yaml); [执行 raw/derived/audit 保留与删除策略](../../.vibehub/tickets/ticket-runtime-retention-pruning-v0.yaml) |
| [容量、故障隔离与 rollback staging 演练](../../.vibehub/tickets/ticket-runtime-staged-rollout-degradation.yaml) | draft | [Harden worker execution failure recovery](../../.vibehub/tickets/ticket-runtime-worker-failure-recovery.yaml); [Prove backup, point-in-time recovery, and clean-environment restore](../../.vibehub/tickets/ticket-runtime-backup-restore.yaml) |
| [上线受保护的 internal alpha 并验证边界](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) | draft | [容量、故障隔离与 rollback staging 演练](../../.vibehub/tickets/ticket-runtime-staged-rollout-degradation.yaml) |

### Post-alpha expansion

| Ticket | Maturity | Direct prerequisites |
| --- | --- | --- |
| [Implement resumable offline local-to-cloud event and semantic-state synchronization](../../.vibehub/tickets/ticket-runtime-local-cloud-sync-v0.yaml) | draft | [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Define a connector substrate for webhook, polling, backfill, lifecycle, and quota handling](../../.vibehub/tickets/ticket-runtime-connector-substrate-v0.yaml) | draft | [Propagate source tombstones, ACL changes, and permission revocation through derived state](../../.vibehub/tickets/ticket-runtime-source-access-invalidation-v0.yaml) |
| [Implement GitHub repository, push, ref, pull-request, review, check, and permission ingestion](../../.vibehub/tickets/ticket-runtime-github-connector-v0.yaml) | draft | [Define a connector substrate for webhook, polling, backfill, lifecycle, and quota handling](../../.vibehub/tickets/ticket-runtime-connector-substrate-v0.yaml); [Model immutable Git commits and mutable ref movements as canonical provenance](../../.vibehub/tickets/ticket-runtime-git-commit-ref-provenance-v0.yaml) |
| [Build Policy shadowing, activation, canary, and rollback](../../.vibehub/tickets/ticket-runtime-policy-rollout-v0.yaml) | draft | [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [Build semantic compaction as an independent Context consumer](../../.vibehub/tickets/ticket-runtime-compaction-v0.yaml) | draft | [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [复杂 query 的异步 synthesis worker](../../.vibehub/tickets/ticket-runtime-query-synthesis-worker-v0.yaml) | draft | [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [发现可独立执行工作的 planning proposal worker](../../.vibehub/tickets/ticket-runtime-planning-worker-v0.yaml) | draft | [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [把 validated candidates 综合成 canonical proposal](../../.vibehub/tickets/ticket-runtime-canonicalization-worker-v0.yaml) | draft | [Build and probe the user-managed Codex worker adapter](../../.vibehub/tickets/ticket-runtime-codex-worker-adapter-probe.yaml); [Build full Policy replay and JudgeOps evaluation gates](../../.vibehub/tickets/ticket-runtime-judgeops-v0.yaml) |
| [真实任务受控下游收益评测](../../.vibehub/tickets/ticket-runtime-downstream-value-v0.yaml) | draft | [上线受保护的 internal alpha 并验证边界](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) |

## Replacement of the five broad Contracts

All five IDs and Contract V1 histories remain readable. Their V1 Acceptance
revisions are retired, not deleted or marked achieved. Contract V2 selects
only the new bounded obligations; same-Ticket splits cite exact derived_from
references. Cross-Ticket responsibility transfers are recorded below because
the Acceptance lineage schema is local to a Ticket. No successful Outcome
is fabricated to hide or archive old work.

| Existing Ticket | Current bounded responsibility | Obligations moved to separate Tickets |
| --- | --- | --- |
| [Working Graph revision / assertion / conflict 可执行契约](../../.vibehub/tickets/ticket-define-semantic-context-protocol-v0.yaml) | Executable Working Graph revisions/assertions/snapshots/conflicts | Scope identity → identity; causal ordering → watermark contract; external canonical writes → canonical Git bridge. |
| [选择具体 alpha 平台与部署边界](../../.vibehub/tickets/ticket-select-semantic-runtime-alpha-platform.yaml) | Owner selection of tested platform/destination/cost envelope | Comparison/spike → platform evaluation; deployment commands/secrets/rollback manifest → release pipeline. |
| [组合并验收 Git → Policy → Context 在线闭环](../../.vibehub/tickets/ticket-build-semantic-runtime-service-v0.yaml) | Composition and verification of already-delivered modules | Persistence → store and Graph adapter; APIs → semantic API; policy behavior → ingress policy; promotion → canonical bridge. |
| [提供最小 semantic activity 与精确引用页面](../../.vibehub/tickets/ticket-build-semantic-collaboration-surface-v0.yaml) | Minimal inspectable version/proposal/conflict and audit UI | Query/overlay → query engine/compiler; realtime transport → session delivery; conflict journey → integrated loop. |
| [上线受保护的 internal alpha 并验证边界](../../.vibehub/tickets/ticket-launch-semantic-runtime-online-alpha.yaml) | Exact-build live deployment, bounded smoke and operator handoff | Instrumentation → telemetry; rollback/load faults → staging rehearsal; backup/restore and CI each own a Ticket. |

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

A Codex capability probe that finds the executor unavailable must leave its
live-job criterion unresolved and close partial/failed or replan; reporting that
the probe ran cannot unlock the integrated loop or launch. A successful dependency
Outcome requires the supported synthetic end-to-end job, not only an inventory
of missing capabilities.

## Planning validation

Two independent read-only reviews passed the final 54-Ticket candidate: one
checked contracts, history, Context, dependencies and maturity; the other checked
architecture coverage, business ownership, Git/worker failure paths and operational
acceptance. Candidate SHA-256:
`24a833ed718f17e627e1f7fd9dc14ec1176e3bed0e34b18ee1432d46617f5e17`.
The batch contains 13 firm and 41 draft Tickets, with 197 active criteria.
This validates the plan only; execution Evidence and independent Outcomes remain
future work. Concrete environment mechanisms and capability probes are recorded
as refinement work, not extra human approval gates.
