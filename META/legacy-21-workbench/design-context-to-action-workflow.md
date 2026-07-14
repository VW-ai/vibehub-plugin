# Context-to-Action Workflow — Task / Run / Workspace Authority

Status: APPROVED CORE — implementation details open
Date: 2026-07-13
Room: 21-workbench
Related: decision-project-017/024/026, decision-workbench-010/011/012/013

## 1. Product position

VibeHub is not the place where development happens. People continue to work in
Claude Code, Codex, and future agent-native environments. VibeHub runs inside
those environments as a **context-to-action layer**:

1. preserve and retrieve context;
2. recognize what work is taking shape;
3. recommend the next execution topology;
4. make task creation, delegation, worktree isolation, and handoff physically
   smooth;
5. observe the result and feed execution evidence back into the context system.

The App is an optional observability/intervention surface. It must not become a
development control plane or a prerequisite for this workflow.

## 2. Core ontology

### Task

A Task is a durable, independently meaningful outcome with a success criterion.
It is not a session, an agent invocation, or a worktree. A changed success
criterion or an independently acceptable/mergeable result is the primary signal
for splitting a new Task.

Inline work remains on the current Task when the success criterion is stable. It
may continue the existing scope or create a new version of that Task's semantic
or file scope.

### Run

A Run is one bounded execution episode attached to a Task. Sessions and
sub-agents participate through Runs. Authority belongs to the Run, not to the
Task type and not implicitly to the agent process.

One Task may move through several Runs:

```text
Task: ship repository-scoped task identity
  ├─ Run 1 — context shaping
  ├─ Run 2 — supervised development
  └─ Run 3 — mechanical verification loop
```

### Workspace and writer lease

A context-only Run does not require a worktree; it is bound to a repository
snapshot/base commit for provenance. When a Task first enters code-write mode,
it claims one canonical writer worktree. The main checkout counts as a worktree.

```text
active code-writing Task ── owns at most one writer worktree
writer worktree          ── serves at most one active Task
```

Multiple code-writing Runs on the same Task are strictly serial. The active
writer holder is a `run_id`; grant, transfer, and release advance a monotonic
fencing epoch so a delayed/stale Run cannot continue writing after handoff.
Parallel independently acceptable code work must split into separate
Tasks/worktrees (or be explicitly modeled as a race between Tasks).

## 3. Authority model

Context mutation is not binary. In particular, a mechanical executor still
updates the broad context system by appending logs, findings, test results, and
other execution evidence. That must not grant it authority to redefine semantic
truth.

```text
Context authority:
  QUERY
    < APPEND_EVIDENCE
    < PROPOSE_SEMANTIC
    < PROMOTE_SEMANTIC

Code authority:
  READ < WRITE
```

`PROMOTE_SEMANTIC` remains guarded/reviewed under decision-workbench-012 and is
not implicitly granted to any normal Run.

### Context shaping

- context: query + append evidence + propose semantic candidates;
- code: read only;
- examples: codebase reading, research, product definition, architecture,
  distillation, planning;
- no worktree lease required;
- an attempted first code write triggers a workflow transition.

### Mechanical execution

- context: query frozen semantic context + append operational evidence;
- code: write within a frozen execution contract;
- examples: deterministic migrations, verification loops, mechanical fixes,
  implementation against a settled brief;
- may not redefine objective, success criteria, product decisions, or canonical
  semantic context;
- ambiguity produces a persisted finding and pauses/escalates the Run.

The frozen execution contract includes objective, success criteria, allowed
scope, base commit, context/version references, acceptance checks, and stop or
escalation conditions.

### Supervised development

- context: query + append evidence + propose semantic candidates;
- code: write;
- the human remains closely present while context/spec and implementation
  co-evolve;
- scope changes are versioned rather than silently overwritten;
- stable mechanical portions should be frozen and delegated to mechanical Runs.

Top-level interactive sessions may enter supervised development. Autonomous
sub-agents default to context shaping or mechanical execution; they do not
receive joint semantic-and-code authority implicitly.

## 4. Database truth separation

The database must preserve distinct meanings instead of treating every write as
the same kind of "context update":

```text
Semantic truth
  canonical specs / decisions / mappings
          ▲ guarded review + activation
Semantic candidates
  proposed revisions / distillation candidates / interpreted semantic findings
          ▲ provenance links
Operational evidence
  tasks / runs / sessions / events / footprints / commands / tests / outcomes /
  raw execution findings
```

Mechanical Runs append operational evidence and may create explicit **execution
findings** in that layer. They do not mutate semantic candidates or canonical
truth. A later authorized context-shaping/supervised Run may interpret an
execution finding into a separately versioned semantic proposal; provenance
must link the proposal back to its evidence. Evidence must retain links to
`repo`, `task`, `run`, `baseCommit`, and relevant semantic/context versions.

This extends the two truth layers in decision-workbench-012; it does not create
a filesystem shadow database.

### Logical storage contract

This is a logical model, not yet a physical migration. It exists to prevent the
implementation from collapsing unlike writes into one mutable context table.

| Record | Meaning | Mutation rule |
|---|---|---|
| `task` | Repository-scoped durable outcome and lifecycle | Stable opaque ID; never derived from branch name |
| `task_scope_version` | Objective, success criteria, semantic/file scope at a point in time | Immutable versions; one current pointer advanced by CAS |
| `run` | Bounded episode, mode, context/code authority, state | Explicit start/transition/checkpoint/complete |
| `run_context_binding` | Base commit and exact semantic/candidate versions read by a Run | Frozen for mechanical Runs; versioned for supervised Runs |
| `task_workspace_binding` | Task's canonical writer worktree/branch metadata | At most one active binding for a code-writing Task |
| `run_writer_lease` | The Run currently allowed to mutate that workspace | One active holder per Task/worktree, guarded by a monotonic fencing epoch |
| `operational_event` / `evidence` | Hook events, commands, tests, outcomes, footprints, artifacts | Append-only and provenance-complete |
| `execution_finding` | Ambiguity/failure discovered by execution | Operational record; may be open/interpreted/dismissed, never canonical |
| `semantic_proposal` | Authorized interpretation that may revise semantic context | Separate versioned record linked back to evidence/finding |
| `handoff_packet` | Checkpoint plus exact Task/Run/context/workspace references | Immutable payload; consumption is a separate event |
| `intervention_decision` | Recommendation, user response, and deduplication fingerprint | Append-only; new evidence creates a new fingerprint |

All transitions go through versioned operation contracts and the shared
dispatcher from decision-workbench-012. Workspace binding and writer-lease
changes must be transactional/CAS operations. An `execution_finding` cannot become a
`semantic_proposal` by changing its type/status in place; interpretation creates
a new proposal with provenance. Raw events may be compacted into artifacts, but
their addressable provenance and integrity hash remain. No workflow state is
authoritatively stored in a filesystem checkpoint.

Every evidence write carries at least `evidenceId`, `kind`, `repoId`, `taskId`,
`runId`, `sessionId`, `actorId`, `executionContractVersion`, `baseCommit`,
`headCommit`, semantic/context version references, `occurredAt`, `ingestedAt`,
`requestId`/idempotency key, and payload checksum. Interpreting evidence creates
a new semantic proposal plus provenance edge; it never moves or rewrites the
source evidence.

Task and Run IDs are immutable, repository-scoped opaque identities. Resolution
precedence is: explicit Task/Run token → persisted session binding → branch
fallback only while capturing a previously unknown session. Subsequent hook
events resolve through the persisted session binding—not by recomputing
`branch:<branch>`. Branch switches update observed workspace metadata and
evidence; they do not silently move the session to another Task.

## 5. Workflow state model

Do not encode every combination in one giant enum. Three orthogonal dimensions
drive intervention:

```text
Semantic lifecycle
DISCUSSING → SHAPED → COMMITTED → ACTIVE → CHECKPOINT → INTEGRATED

Execution topology
INLINE ↔ DELEGATED ↔ HANDOFF

Workspace state
UNCLAIMED → OWNED → CONTESTED → RELEASED
```

Semantic lifecycle belongs to the Task/scope version; execution topology to the
Run/session binding; workspace state to the Task workspace binding and Run
writer lease. `CHECKPOINT` and `HANDOFF` are persisted transitions, not new Task
levels or user-facing hierarchy.

The central question is whether the current Run's authority envelope and
execution topology still match the work now occurring.

## 6. Intervention policy

Intervene at decision boundaries, not on a timer. Mechanical hook evidence only
creates a transition candidate; semantic judgment belongs to a workflow skill.

| Boundary | Assessment | Physical response |
|---|---|---|
| First attempted code write | Has a bounded Task formed? | Continue inline, enter supervised development, or freeze/delegate mechanical execution |
| New user requirement | Same success criterion or new deliverable? | Version current scope or split a Task |
| Sustained scope drift | Temporary exploration or changed work? | Update scope, delegate, handoff, or split |
| Independent bounded unit | Can it be independently accepted? | New Task/worktree, otherwise a Run on the current Task |
| Semantic ambiguity in mechanical Run | Is frozen context insufficient? | Pause, persist finding, return to context/supervised Run |
| Context saturation/compact/checkpoint | Is current session still the best carrier? | Persist checkpoint and create handoff packet |
| Writer workspace contested | Does another active Task own it? | Hard-block code write until attach, handoff, or new worktree |
| Stop/PR/merge | Paused, waiting, or accepted? | Settle evidence, update state, release lease |
| Context-only acceptance | Has the outcome been explicitly accepted without code/PR? | Host-agent `CLOSE` records actor + evidence and completes the Task |

Intervention strength:

1. **silent** — same Task and authority still fit;
2. **auto + inform** — low-risk scope version or bookkeeping;
3. **recommend + confirm** — Task split, worktree creation, delegation, handoff;
4. **hard block** — only for ownership/isolation violations or explicit safety
   constraints.

Declined advice is recorded and deduplicated. The same proposal must not reappear
until objective, scope version, authority need, or execution evidence changes
materially.

## 7. Physical adapter flow

```text
Hook event
  └─ deterministic matcher identifies a transition candidate
       └─ micro-instruction asks the host agent to run workflow assessment
            └─ workflow skill reads task/context/evidence and chooses
               CONTINUE / EXPAND / DELEGATE / HANDOFF / CLOSE
                 └─ MCP/CLI performs deterministic state transition
```

Future deterministic operations are expected around:

- stable repository-scoped Task identity;
- Run start/transition/checkpoint/complete;
- session/sub-agent binding by Task/Run token rather than repeated branch guess;
- writer-worktree claim, transfer, release, conflict, and recovery;
- execution-contract freeze;
- handoff packet create/consume;
- evidence/finding append with provenance.

Enforcement strength is adapter-specific. Interceptable mutation tools such as
Edit/Write must preflight the active writer holder and fencing epoch. Opaque
Bash/external processes cannot always be classified before side effects, so
they require best-effort preflight plus post-event reconciliation. Each host
adapter must publish an honest coverage matrix; it may claim “no write without
lease” only for paths that actually validate the holder token.

For delegation, the current top-level session can remain the coordinator. A
read-only research sub-agent is a context-shaping Run without a worktree. A
mechanical sub-agent receives a frozen contract and writer lease. If a mechanical
Run executes on the current Task, the supervising Run temporarily relinquishes
write authority; independently parallel code work splits into a new Task and
worktree.

For handoff, VibeHub stores the checkpoint/packet in SQLite and produces a single
launch action. A new Claude/Codex session consumes an explicit Task/Run token at
SessionStart. The App may later render this as a button, but the headless plugin
path remains complete.

### Relationship to the current audit fix loop

The active audit/debug loop in
`docs/superpowers/specs/2026-07-13-workbench-audit-fix-loop-design.md` repairs the
existing M2 implementation. It remains the owner of current defects such as
cross-repository branch-task collisions, hook claim/rollback ordering, scope
classification, production App behavior, and packaging verification. This
design does not duplicate or expand those repair boundaries.

In particular, audit B1's repository-qualified task ID closes the current
`branch:main` collision. It is a compatibility repair, not completion of the
durable Task/Run identity protocol defined here. Writer leases, fencing epochs,
authority-bearing Runs, explicit handoff tokens, and headless `CLOSE` are future
context-to-action capabilities and require their own implementation plan after
the audit loop is stable.

## 8. Approaches considered

### A. Advisory prompts only

Reuse current branch-derived capture and add recommendations in hook text.

- smallest implementation;
- cannot guarantee stable identity or workspace isolation;
- repeats the current gap: observation without reliable workflow shaping.

### B. Authority-aware Runs + writer leases (recommended)

Keep Task as the durable outcome, introduce Run authority and explicit workspace
ownership, and let skills decide semantic transitions while core enforces them.

- matches the existing skill-intelligence boundary;
- works headlessly inside Claude/Codex;
- supports context work, mechanical loops, and supervised development without
  forcing them into one workflow;
- requires careful migration from branch-derived task identity.

### C. App-owned workflow engine

Create/launch all work from the Workbench App and make it the scheduler.

- visually direct;
- contradicts the product position and misses users working directly in host
  agents;
- makes headless operation incomplete and is therefore rejected.

## 9. Success criteria

- Ordinary continuation inside a valid Task/Run is silent.
- Before the first code mutation, the session has a stable Task/Run binding and
  appropriate authority.
- Two active Tasks cannot hold writer authority over one canonical worktree.
- One Task cannot have two concurrent writer Runs, and a stale fencing token is
  rejected after lease transfer.
- Mechanical execution can append complete evidence without changing semantic
  truth.
- Semantic ambiguity in mechanical execution pauses/escalates instead of being
  silently decided.
- A context-only Task can become supervised or mechanical without losing its
  provenance.
- Delegation and handoff require at most one user confirmation after the system
  explains why the topology should change.
- Claude Code and Codex can use host-specific adapters over the same Task/Run/
  workspace protocol; the App is optional.

## 10. Open questions

1. Exact semantic thresholds for Task split versus scope evolution.
2. Host-specific mechanics for launching Claude/Codex sub-agents and top-level
   handoff sessions with a Task/Run token.
3. Lease expiry and crash recovery without introducing a daemon.
4. Whether a supervised Run must always be a top-level interactive session, or
   whether explicitly authorized supervised sub-agents are useful.
5. How execution findings become semantic proposals without duplicating the
   existing review/distillation lifecycle.
6. UX wording and cooldown rules for repeated declined interventions.
7. Migration of current `branch:<branch>` identity and branch-switch behavior to
   stable repository-scoped Task/Run bindings.

## 11. Compatibility with the earlier branch model

Decision-project-024's universal phrase "one thing = one branch = one PR" is
narrowed by this decision. It remains the default lifecycle for a Task after it
acquires code-write authority; it does not apply to a context-only Task. Tasks
remain flat—Runs are execution episodes and provenance records, not sub-Tasks or
a new user-facing hierarchy. Branch/worktree also remains Task metadata rather
than a UI organizing unit.

PR merge remains the preferred mechanical acceptance signal for code-writing
Tasks, not a universal completion gate. A context-only or authorized non-PR
Task can complete headlessly through an explicit host-agent `CLOSE` operation
that records the accepting actor and supporting evidence; the App is optional.

## 12. Explicitly not in scope

- Building an IDE, terminal multiplexer, or universal development control plane.
- Requiring all work to start in the App.
- Creating a worktree for context-only work.
- Granting autonomous agents implicit semantic promotion authority.
- Modeling every agent invocation as a Task.
- Solving every possible developer workflow before the three primary modes are
  dogfooded.
