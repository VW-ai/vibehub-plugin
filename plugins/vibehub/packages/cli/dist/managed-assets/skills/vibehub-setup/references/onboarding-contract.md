# Onboarding contract

## Evidence ladder

Treat the setup result as a three-level proof, not a checklist:

- **Installed** means the packaged runtime manifest is non-empty and its native
  dependency and managed assets are healthy.
- **Connected** additionally requires healthy runtime and instruction blocks
  plus a host hook session observed after the current blocks, for the exact
  checkout.
- **Activated** additionally requires a qualifying successful context-value
  operation after that host handshake.

Doctor health, created files, a successful apply, or a process restart alone do
not advance the next proof level. Use each `activation.*.state` and its evidence
verbatim. A `not_proven` state is waiting, not failure and not success.

## Deterministic operation sequence

Inspect before mutation, apply once with the same target and executable, then
read status. Parse JSON on both zero and non-zero exits. The receipt is
`ProjectActivationResultV1`; fields and checksums are facts owned by the CLI.
Do not directly edit managed markers or bypass runtime operations to alter
persistent state.

If the second apply is current, its expected result is unchanged and has no
file effect. Repeated setup is maintenance, not another activation.

## Honest project branching

Inspect both tracked substantive files and repository history. This is a
semantic skill judgment, not a new core classifier:

- Unborn history, documentation-only content, or scaffold-only tracked files
  means fresh. Let context accumulate while the user explores, brainstorms, or
  adds project documents. Never run `git init` and never create fake knowledge.
- Meaningful tracked implementation plus established history means
  existing-code. Offer `$vibehub-distill` as an explicit, visible, skippable
  cold start.
- Mixed or uncertain file/history evidence remains ambiguous. List the observed
  signals and ask the user which path applies instead of using a file-count
  threshold.

After Connected, use a meaningful `$vibehub-query` when governed context
already exists, or `$vibehub-ingest` when authentic durable evidence emerges.
An empty query, failed query, or skipped/failed ingest is not context value and
cannot prove Activated. Do not manufacture a write merely to move the state.

## User-visible report

Use five plain-text fields: `Activity:`, `Trigger:`, `Effects:`, `Result:`, and
`Next:`. Effects must name only actual file, runtime, or context changes.
Result must preserve waiting, blocked, partial, unchanged, and proven states.
Next must distinguish required action from an optional recommendation.

Before a real dogfood attempt, obtain user approval and an exact target path.
Packaged artifact checks and local fixtures are not real Claude host proof.
