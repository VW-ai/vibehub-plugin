# Reconciliation business bundle v0

Wire version `1` implements a bounded business protocol over the accepted
[Worker Job/Result transport](worker-protocol-v0.md). It consumes immutable
[Working Graph revisions](working-graph-v0.md), retains every competing claim and
its provenance, and returns a separately materialized **proposal artifact**.
There is no model/provider call, source retrieval, queue, Graph mutation,
canonical write, acceptance decision or PolicyRun execution in this module.

The synthetic corpus proves deterministic structure and abstention rules for
recorded reference answers. It does not measure live reasoning, semantic quality,
model reliability, useful conflict resolution or downstream product value. The
Codex adapter and integrated-loop Tickets own later supported live execution.

## API and immutable bundle

| Export | Contract |
| --- | --- |
| `RECONCILIATION_BUNDLE` | Frozen instruction text plus ID, version, exact instruction digest and output-schema digest. |
| `RECONCILIATION_OUTPUT_SCHEMA` | Strict JSON Schema for the structured proposal; executable checks additionally enforce bindings and authority. |
| `RECONCILIATION_CONFIG_SCHEMA` | Primitive Worker operation config schema accepted by the Policy compiler. |
| `reconciliationPolicyConfig(request)` | Pins bundle version, instruction digest, output-schema digest and trusted request digest. |
| `createReconciliationInput(job, admission, request)` | Requires current Worker admission, exact business pins and complete competing-parent closure; returns frozen claims, sources and bindings. |
| `validateReconciliationProposal(proposal, input)` | Checks proposal syntax, exact preserved refs, source scope and status/authority rules; returns `true` or throws. The input must come from trusted construction. |
| `encodeReconciliationProposal(proposal, input)` | Validates, serializes canonical JSON, and returns `{artifact_json, digest}`. |
| `validateReconciliationResult(envelope, admission)` | Verifies exact artifact bytes and transport bindings, reconstructs trusted input, rechecks current admission and validates the business proposal. |

`RECONCILIATION_VERSION`, `RECONCILIATION_ISSUES` and
`RECONCILIATION_STATUSES` expose the supported wire vocabulary. All returned
objects and constants are deeply frozen. No entrypoint mutates its arguments.
Unknown fields/versions, accessor properties, symbols, non-enumerable properties,
cycles, nonfinite numbers and sparse arrays reject before getters can run.

The instruction digest hashes the exact UTF-8 instruction string, including its
newlines. The output-schema and request digests hash canonical JSON: object keys
sorted recursively, array order preserved, compact encoding, no trailing newline.
A schema or instruction change therefore needs a new bundle pin/version and a
new compiled policy. `latest` lookup is never involved. The existing Worker
transport output schema remains unchanged.

Trusted composition supplies the request:

```js
const request = {
  schema_version: 1,
  issue: 'equivalence',
  decision_authority: 'agent', // or 'human'
};
const config = reconciliationPolicyConfig(request);
// Compile a Worker operation using RECONCILIATION_CONFIG_SCHEMA and this config.
// Construct a Job pinned to the resulting policy/operation and exact Graph inputs.
const input = createReconciliationInput(job, admission, request);
```

The complete config must be installed on the Job's triggering WorkerNode before
compilation. Both compiled policy hashes bind it. The request digest avoids a
circular dependency on Job/policy identity: the small request only declares the
issue and trusted decision boundary; the Job separately pins exact Graph and
source inputs. Changing either authority or issue after enqueue rejects against
the immutable policy. A transport-only policy with empty business config fails.
The trusted dispatcher supplies these declarations; content that claims to be a
human decision cannot set them.

`admission` is the accepted Worker admission context: trusted catalog, compiled
policy artifact, current Graph, current authorization and assigned executor. The
bundle also requires `worker_type: 'semantic-reconciliation'` and effective
`propose_resolution` capability. The result's executor must exactly match this
assigned descriptor. Hashes and descriptors prove identity/integrity, not
credentials. Source and actor authentication remain the service's responsibility.

## Input and preserved scope

Each input claim copies the exact Graph assertion's semantic `content` and its
complete `provenance`, including independently observed source restrictions and
access events. Content may contain unknown audience/scope or malicious tool text;
it remains nested source data. It cannot become instructions, capabilities,
authority, a retrieval target or a policy choice.

The input retains the exact GraphRevision and all selected semantic addresses.
If any selected revision participates in an open conflict, **every assertion in
that conflict must be selected**. Even a Worker Job otherwise admitted to read
only one side is insufficient for this business bundle. Conflicts with three or
more parents are treated the same way; they cannot be reduced to a chosen pair.

A proposal contains all original `parents`, `citations` and `retained_claims` in
the same order. Each citation pins the complete normalized source-event digest
and its index in the immutable Job, not only a Git OID or source name. Each
retained claim carries its own exact revision and complete source-event indexes;
a global citation list cannot hide per-claim provenance loss. Source events can
be different observations of the same object, and remain distinct exact inputs.
Missing, duplicate, reordered, out-of-scope, alternate-generation or fabricated
refs reject. Complete citations do not automatically attest to the truth of a
model's explanation.

The structured resolution has `scope_mode: 'per_parent'`. It proposes a
relationship among those preserved claims within each original scope. V1 has no
replacement text, replacement scope, merged canonical fact, dropped-parent list,
commands or executable payload. An unknown original audience stays unknown;
worker output cannot create a broader structured audience or Project scope.
Access restrictions continue through the retained exact provenance and current
Worker admission. A later derived assertion would need its own Graph transition
and access checks; this validator cannot authorize it.

## Status semantics

| Trusted issue / decision boundary | Permitted resolved relationship | Abstention |
| --- | --- | --- |
| `compatible_changes`, Agent authority | `compatible` | `unresolved` with `retain_alternatives`, `stale`, or escalation to a human. |
| `equivalence`, Agent authority | `equivalent` | Same abstention choices; both origins remain even if equivalent. |
| `contradiction` | None in this conservative first bundle. | Preserve alternatives as unresolved, stale, or human-decision-required. |
| `scope_ambiguity` | None until a new request has explicit sufficient context. | Preserve alternatives; do not infer missing scope. |
| `source_disagreement` | None without a separately established decision. | Preserve alternatives; no implicit code-wins/docs-win or arrival-order rule. |
| Any Human authority request | None. | `human-decision-required` or `stale` only. |

All four statuses (`resolved`, `unresolved`, `stale`,
`human-decision-required`) describe a **proposal**. `resolved` means a proposed
compatible/equivalent relationship, not Graph resolution, canonical promotion or
Acceptance success. Human-required/stale results use resolution kind `none`.
A Human authority request cannot be downgraded to Agent authority or relabeled
unresolved to conceal its human boundary. An Agent-owned request may conservatively
escalate to a human, which grants no new authority.

`explanation` is bounded, untrusted display text. It may be semantically wrong or
repeat malicious instructions while the reference-preserving proposal remains
structurally valid. Consumers must render it as data and must never parse it into
instructions, citations, capabilities, authoritative replacement facts or
commands. Executable validation deliberately does not claim to solve semantic
truth verification. A later real executor evaluation must measure that separately.

## Transport artifact and current validation

Publish the exact `artifact_json` returned by `encodeReconciliationProposal` as
UTF-8 bytes and use its SHA-256 `digest` in a Worker `kind: 'proposal'` artifact
reference. The artifact reference must retain all Job source indexes. At least
one `propose_resolution` finding must link the artifact with all exact input and
source indexes. Business semantics are never encoded solely in its summary.

```js
const checked = validateReconciliationResult({
  job, result, request,
  artifact_index: 0,
  artifact_json, // exact stored canonical UTF-8 JSON text
}, admission);
```

The validator checks the entire Worker Result first, verifies the selected
artifact's exact byte digest, refuses noncanonical encodings (including duplicate
JSON keys and whitespace changes even if rehashed), and reconstructs input from
the trusted current Graph. A caller-supplied model input is never accepted here.
The artifact is at most 1 MiB; JSON traversal is bounded to 250,000 values,
depth below 40 and 16,384 characters per ordinary string. Explanations are capped
at 4,096 characters. Worker limits still cap the Job at 32 semantic revisions and
64 source events. These are bounded contract limits, not capacity measurements.

A valid current proposal returns
`{status: 'validated', reason: 'proposal_only', proposal, effects: []}`.
Graph/source movement or unavailable source inputs return `stale`; current
authorization denial returns `denied`. Both return `proposal: null` and zero
effects. Malformed or mismatched business data throws. A revoked proposal
operation throws rather than accepting the artifact. A worker-reported `stale`
status on otherwise current input is a retained abstention proposal, not proof
that Runtime's freshness checks found a stale Graph.

This business check is **not** Worker completion admission. The caller must also
perform the accepted transport state transition with the actual Job/Attempt,
lease, fence, trusted time, current authorization and atomic state/receipt CAS.
A schema-valid artifact can still arrive after lease expiry and must be rejected
by that transport gate. These are separate checks, neither replacing the other.

Later result ingress must validate a **new PolicyRun** and its legal business
result route against fresh explicit inputs. The WorkerNode's enqueue-success
edge is not automatically a result route. Neither a validated artifact nor its
transport's `result_available` effect authorizes arbitrary policy entry, Graph
resolution, an Outcome, canonical writes or human decisions.

## Reproducible synthetic checks

```sh
node --test test/reconciliation.test.mjs
npm run check:boundaries
```

`test/fixtures/reconciliation/cases.json` deliberately contains only invented
claims and recorded reference answers. `labels.json` is evaluator-only and never
enters Job/model input. The fixture constructor builds real Graph assertions and
a compiled bundle-bound Worker policy. Cases cover compatible changes, numeric
equivalence, direct contradiction, ambiguous audience, disagreement between
pinned sources, a human-owned decision, malicious source instructions and a
reported-stale abstention. Additional executable checks move the actual Graph,
apply actual ACL/tombstone changes, revoke current grants, omit competing parents,
forge citation/source scope, mutate the trusted human request and inject unsupported
fields or artifact bytes. Both accepted and rejected paths leave Graph state
unchanged. Expected structured status/abstention counts are reported by these
tests; no live model success rate is inferred.
