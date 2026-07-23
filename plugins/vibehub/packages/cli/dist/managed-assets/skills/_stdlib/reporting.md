# Reporting contracts

## Dispatcher envelopes are the evidence

Consume only dispatcher envelopes:

```json
{"ok":true,"data":{},"meta":{"operation":"kb.status","repoId":1,"requestId":"...","at":"..."}}
```

or:

```json
{"ok":false,"error":{"code":"...","message":"...","details":{},"nextSafeActions":[]}}
```

Never claim a mutation succeeded unless `ok` is true. Report IDs, states,
request/run/version IDs, defaults, conflicts, unresolved evidence, and the next
explicit review action. Keep evidence excerpts bounded and cite source refs.

Query output must conform to `../contracts/context-packet.schema.json`; ingest,
scope and validation artifacts must conform to their named schemas before use.

## Presentation protocol (five portable sections)

Every user-visible VibeHub workflow report uses these exact plain-text
labels, in this order:

```text
Activity: <workflow> — what VibeHub is doing
Trigger: <why it ran now>
Effects: <what was actually read, written, queued, or injected — or none>
Result: <honest outcome plus counts and IDs>
Next: <required or optional action, or none>
```

Rules:

- The labels are plain text. They must stay readable with no color, no
  ANSI, a narrow terminal, copied logs, and collapsed tool results. Color
  may only enhance, never carry the meaning.
- Result vocabulary is the shared receipt outcome language: persisted,
  returned, verified, queued, claimed, attempted, skipped, failed, waiting.
  Do not invent per-workflow synonyms.
- queued, claimed, delivered, acknowledged, and persisted are different
  claims. This runtime can prove queued, claimed, and persisted; it
  cannot prove delivered or acknowledged — never state either.
- Success copy requires deterministic success evidence: an `ok` true
  envelope, a proof state, or a persisted receipt. Prose, exit codes
  alone, or a plan are not evidence. Failed and waiting results are always
  visible, and waiting names the required action in Next.
- Effects name only real changes. A no-op or duplicate is "none", not a
  celebration.

## Visibility budget

Three visibility levels keep high-frequency mechanics from becoming noise:

- **silent** — routine mechanical evidence, no-op refreshes, duplicate or
  no-change operations, and context pulls folded into ongoing work. No
  user-visible block.
- **brief** — one compact five-section block: a successful ingest capture,
  a queued or claimed injection, a checkpoint-triggered capture, a
  user-invoked query answer, an executed review decision.
- **expanded** — the full block with evidence detail: setup, distillation
  and incremental update runs, conflicts, every failure or recovery, and
  anything waiting for user review or action.

Per-workflow defaults: setup runs are expanded; a routine healthy
verification may be brief. Query is brief when the user asked and silent
when mechanical; an empty or missing answer is still brief — an honest gap
is information. Ingest success is brief. Distillation and update runs are
expanded. Review decisions are brief; a queue still waiting for review is
expanded. Failures and waiting states are never silent.

## Checkpoint reminders

A periodic knowledge checkpoint reminder asks for judgment, not ceremony.
If durable knowledge exists, run the ingest workflow and report its normal
brief block. If none exists, continue working: no filler records and no
"nothing to do" block.
