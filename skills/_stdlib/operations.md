# Operation boundary

Skills and scripts call `vibehub ... --json`; they never import storage
drivers, query backing stores directly, or mutate persistence files. MCP tool `kb_operation` accepts
the exact `kb.*` operation plus `input`; `distill_operation` accepts the exact
`distill.*` operation plus `input`. Both return the same dispatcher envelope.
`kb_retrieve` is only the focused `kb.spec.search` convenience adapter. MCP
v0.2 exposes no legacy mutation aliases; route writes through these canonical
adapters so evidence, task attribution, request identity, and version
transactions remain enforceable.

## Change boundary

- `SKILL.md`, `_stdlib`, and domain references own semantic judgment and
  workflow policy. A persistence migration alone must not require them to
  change.
- Contracts may change only when the public semantic operation or workflow
  artifact changes—not when its implementation changes.
- Scripts and setup host references are mechanical adapters. They may change
  with CLI, MCP, packaging, or host integration while preserving the same
  semantic operation boundary.

## Invocation

```text
vibehub kb <suffix> --json --repo <root> --actor <id> --request <id> [--task <id>] --input -
vibehub distill <suffix> --json --repo <root> --actor <id> --request <id> [--task <id>] --input -
```

Use `--task` for draft/distillation writes. Read input from stdin or a stable
JSON file through `../scripts/vh-kb.mjs` / `../scripts/vh-distill.mjs`.

## Semantic checkpoints

After one coherent sequence of successful canonical knowledge mutations,
request a checkpoint automatically at the next stable workflow boundary:

```text
node ../scripts/vh-checkpoint.mjs prepare --repo <root> [--protect <branch>]
node ../scripts/vh-checkpoint.mjs commit --repo <root> --actor <id> --task <id> --request <id> --input <receipt.json> [--protect <branch>]
```

Pass every repository-configured protected branch with `--protect`; the
adapter always protects the default branch, `main`, and `master`. Prepare is
read-only. Commit only the exact unchanged receipt. Treat `noop` as
silent and keep working. On a protected branch, detached HEAD, conflict,
invalid knowledge, or stale receipt, create no commit and surface the blocker.
Do not checkpoint read-only queries, candidate/distillation operational state,
failed mutations, or filler records. The adapter owns Git mechanics so entry
skills remain unchanged when the implementation changes.

## Request identity and replay

Treat `requestId` as a repository-wide request identity, not a counter local to
a wrapper, worker, operation, or skill. Generate a canonical, unique ID for each
logical invocation that requires stable retries and carry it unchanged through
those retries. For MCP `kb_operation` / `distill_operation`, pass it only as the
optional top-level tool field, never inside `input`; omit it when replay is not
needed so the capability generates a collision-resistant UUID. Never derive a
repository request ID from an MCP transport correlation ID. Include stable task,
stage, operation, and attempt information when humans need readable names, for
example `task-184:ingest:draft-apply:01` or
`onboard-20260713:distill:inventory-seal:01`. Preview and apply are different
logical invocations and get different IDs.

Replay an invocation only with the same repository, operation, request ID and
exact canonical input. An identical replay returns the stored result at the
common dispatcher boundary. If the envelope says
`requestId was reused with a different operation or canonical payload`, stop and create a new request ID; never mutate
the payload until an old ID succeeds. Canonical KB writes also carry their
operation input's `idempotencyKey`: reuse that key only for the identical
business mutation. Do not reuse any request ID for another operation merely
because a current table key would permit it.

## Registry

| Read | Mutation |
|---|---|
| `kb.status` | `kb.draft.apply` |
| `kb.feature.list`, `kb.feature.get`, `kb.feature.suggest` | `kb.promote`, `kb.mark-stale`, `kb.deprecate` |
| `kb.spec.search`, `kb.spec.get` | `kb.amend`, `kb.supersede` |
| `kb.relations`, `kb.lineage`, `kb.anchors`, `kb.review` | |
| `kb.ingest.preview` | |
| `distill.run.status`, `distill.run.resume` | `distill.run.start`, `distill.run.abort` |
| `distill.baseline.get`, `distill.candidates.list`, `distill.candidates.get` | |
| `distill.version.get`, `distill.version.diff` | |
| `distill.inventory.get`, `distill.inventory.diff` | `distill.inventory.put`, `distill.inventory.seal` |
| | `distill.scopes.plan`, `distill.scopes.claim`, `distill.scopes.complete`, `distill.scopes.fail`, `distill.scopes.retry`, `distill.scopes.correct` |
| | `distill.candidates.put`, `distill.reconcile`, `distill.validate`, `distill.finalize` |
| | `distill.activate`, `distill.rollback` |

Inputs are strict. Read the corresponding JSON schema and the dispatcher error
`nextSafeActions`; do not guess missing fields. Common exit classes: `2`
malformed/unsupported, `3` not-found/already-exists, `4` lifecycle/integrity,
`5` idempotency/lease/checksum/CAS conflict, `1` internal failure.

## Workflow artifacts are not operation inputs

`query-request`, `context-packet`, `distillation-scope`,
`distillation-result`, and `validation-report` describe skill workflow state.
Never pass them directly to a strict dispatcher operation. Translate only the
named fields documented by the entry skill, then validate against the generated
`../contracts/operation-contracts.json`. `ingest-plan` intentionally matches
the exact `kb.draft.apply` input and may be passed after validation.

Candidate reads always select exactly one `runId` or finalized `versionId`.
Version review uses `distill.version.get` plus `distill.version.diff`; counts in
run status are not sufficient evidence for activation.

## Anchor truth layers

| Need | Operation | Meaning |
|---|---|---|
| Current canonical spec anchors, by `specId` or reverse `path` lookup | `kb.anchors` | Canonical anchors from the current revision; independent of mapping activation. |
| Anchors and feature placement in the active mapping used as an incremental base | `distill.baseline.get` | Active-version mapping anchors plus its pinned commit/version identity. |
| Projected anchors/content for one finalized mapping version | `distill.version.get` | Immutable version projection selected explicitly by version ID. |
| Anchor/content changes against the active baseline | `distill.version.diff` | Precomputed version-scoped add/remove/change review surface. |

Do not use `kb.anchors` to claim mapping-version membership, and do not use a
baseline/version anchor to claim that a canonical spec revision is governed or
active. Verify the truth layer named by the question.
