# Versioned Policy Graph artifacts

This contract implements the artifact/compiler portion of Tech Design §9 and
PRD §9.5. It does not execute a Policy Graph, call a model, read an event, mutate
the Working Graph, or publish to a hosted registry. The existing Phase 0 replay
executor remains unchanged. The public APIs are exported from `src/index.mjs`.

## Authoring and trusted operations

`POLICY_ARTIFACT_SCHEMA` is the frozen JSON Schema for graph schema version 2.
`compilePolicyArtifact(definition, { operations })` checks its structural and
graph invariants and returns a frozen artifact. `validatePolicyArtifact` performs
the same checks and returns the normalized definition. Errors reject the whole
definition before publication; there is no partial graph.

A definition names `policy_id`, exact `version`, `schema_version`, compatibility
range, nullable exact `rollback_predecessor`, `entry`, typed `inputs`, whole-graph
`limits`, and a map of nodes. Runtime compatibility is an inclusive integer
protocol-version range, not a package semver range. Names are bounded identifiers;
no `latest` lookup, source path resolution, or implied canonical authority occurs.

All seven node types are supported: `deterministic`, `judge`, `retrieve`,
`aggregate`, `guard`, `action`, and `worker`. Each node specifies a versioned
`operation: { id, version }`, typed `inputs`/`outputs`, `config`, a `budget`,
and named `next` branches. Nonterminal nodes require `on_error`. Action nodes
emit exactly one of `IGNORE`, `INGEST`, `INJECT`, `DEFER`, or `ESCALATE` and have
no outgoing edges. These are terminal intents, not direct canonical writes.

Operations are supplied separately by the trusted composition layer. A descriptor
contains its exact ID/version, node type, `implementation_hash`, input/output
port signatures, `error_outputs`, named branches, `branch_mode`, and config
schema. Branch mode is `exclusive`, `parallel`, or `terminal`. Only deterministic
operations can fork in parallel; only Action operations can terminate. There are
no built-in runnable handlers in this module. The synthetic fixture's operation
identities are deliberately test-only.

The compiler includes the full used operation descriptors in executable identity.
Changing an operation implementation hash or signature changes the executable
hash even if its human version string stays unchanged. A later executor must
match its installed handler against this pinned identity. The hash is an explicit
composition-layer attestation, not proof that arbitrary handler code behaves as
claimed. Unknown and duplicate operation versions are rejected.

Operation config schemas use a bounded subset: a closed object with declared
properties and required names; scalar string/number/integer/boolean fields;
optional enums, numeric minimum/maximum, and string maxLength. Unsupported
keywords are rejected. Operation config has no functions or executable code.
Names like `toString` do not bypass closed-object validation.

## Ports, branches and joins

Port types are opaque `event_ref`, `snapshot_ref`, `signal_ref`, `candidates_ref`,
`job_ref`, `error_ref`, plus `boolean`, `number`, and `string`. Types are exact;
there is no implicit conversion. The compiler never dereferences opaque values.
Node port declarations must match their registered operation signature.

An edge is `{ target, ports }`; `ports` maps **target input name → source output
name**, for example `{ target: "combine", ports: { left: "signal" } }`.
Ordinary edges use node outputs. Error edges use the operation's separate
`error_outputs`. Extra source outputs may be dropped, but nonexistent ports,
incompatible types and undeclared target ports fail compilation.

Every operation success branch must have exactly one named edge. Every
nonterminal operation must have an explicit error edge. Schema 2 deliberately
restricts error edges to terminal `DEFER` or `ESCALATE` Actions. An error terminal
ends the **whole run**, cancelling parallel work; it is not one branch's successful
arrival at a join. Retries happen only within the declared node budget. Fallback
graphs, arbitrary cycles and nested parallel regions are deferred to a future
schema/compiler contract.

Multiple arrivals require a unique named `join`. An `any` join is convergence
of mutually exclusive paths; each arrival must supply every required typed input.
Parallel regions cannot merge at an `any` join before their paired `all` join.
An `all` join names its parallel fork and collects one arrival from each fork
branch. Normal branch paths must reach that join, their internal node regions
must be disjoint, outside paths cannot enter midway, and their supplied input
names must be disjoint and together complete. Alternative routes within one
branch must supply the same port names. This rejects ambiguous input writers,
premature successful termination, and structurally stranded joins. Failure exits
use the explicit whole-run error rule above.

## Bounds and identities

Every node declares finite `timeout_ms`, `max_attempts`, `max_tokens`, and
`max_cost_microunits`. Time/token/cost limits are **per attempt**; zero token/cost
allowance is valid for mechanical nodes. Whole-graph `limits` bound total declared
nodes, attempts, and resource sums. The compiler conservatively sums all nodes,
including exclusive and error alternatives, and multiplies time/token/cost by
attempt count. This is intentionally stricter than a longest-path estimate.
There are at most 128 nodes and 10 attempts per node. Kernel enforcement remains
a separate Ticket; these compile-time bounds do not themselves meter execution.

Compilation rejects missing/unreachable nodes, cycles, incomplete branches,
invalid joins, signature/configuration mismatch, and aggregate budget overflow.
JSON inputs are bounded, reject accessors/cycles/non-finite numbers and unsafe
keys, and are cloned before normalization.

An artifact includes logical ID/version, schema/compiler version, compatibility,
rollback predecessor, `content_hash`, `executable_hash`, normalized definition,
used operation signatures, conservative bounds, and deterministic topological
order. Hashes use SHA-256 over recursively key-sorted compact JSON. Declaration
order, operation registration order, branch/enum set order, and top-level/node
`presentation` labels/descriptions do not alter identity. Other array order is
preserved. Executable identity excludes logical ID/version and compatibility;
content identity includes them and the exact rollback predecessor. Budgets,
configuration, port wiring and operation implementation identity affect both.

## Publication lifecycle

`createPolicyRegistry({ operations, runtime_version })` is a synchronous in-memory
reference implementation for adapter conformance. A hosted adapter must supply
durability, authorization and atomic compare-and-swap itself.

- `publish(definition)` compiles, stores an immutable logical ID/version, and
  returns `{ artifact, activation: null, retired_at: null }`. Duplicate identical
  publication is idempotent. Different content under the same ID/version fails,
  including before activation. Rollback predecessors must already exist under
  the same logical policy ID with the exact content hash.
- `resolve({ policy_id, version, content_hash })` requires an exact reference.
  `active(policy_id)` returns the current publication or `null`.
- `activate(ref, { expected_active, at, actor_ref, reason })` checks compatibility,
  retirement and the exact previous active ref (or explicit `null`). It records
  activation metadata and an append-only history event. Rollback uses the same
  CAS operation with the recorded predecessor, not mutation of artifact content.
- `retire(ref, metadata)` also requires `expected_active`; retiring the active
  artifact clears the active selection. Retirement is irreversible in this
  reference contract. The artifact remains resolvable for old audit records.
- `history(policy_id)` returns activation/retirement history. All methods return
  deeply frozen copies; callers cannot mutate stored artifacts, metadata or refs.

## Phase 0 compatibility and verification

`loadPhaseZeroPolicyArtifact(input)` uses the original Phase 0 validator, returns
the original policy unchanged in a frozen wrapper, and retains its original
`policy_hash`. It does not translate questions, thresholds, deadlines or routing
into new semantics. Feed its `policy` to the existing evaluator only. Schema 1
does not pass as a schema 2 publication.

`node --test test/decisions/policy-artifacts.test.mjs` covers the full node schema,
adversarial malformed graphs, type/branch/budget checks, structured joins,
hash invariance, operation identity changes, registry mutation/CAS/rollback,
and actual before/after Phase 0 judge inputs, input hashes, results and candidate
IDs. Elapsed wall-clock timings alone are excluded from that parity assertion.
The fixture contains synthetic declarations only; no provider calls are needed.
