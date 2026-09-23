# Peel curated trajectory fixture

This fixture is the first deliberately selected real-trajectory corpus for the
Phase 0 Semantic Runtime. It contains 20 chronological semantic excerpts from
the Peel Codex project space: initial VibeHub setup, product decisions,
acceptance evidence, PR review, and unfinished-work recovery.

The checked-in events are curated excerpts, not a transcript export. They keep
the original Chinese/English product meaning while removing people, local
paths, raw thread IDs, credentials, full tool output, generated responses, and
unrelated conversation. Stable `trace://peel/...` aliases preserve traceability
inside the fixture without identifying a live session.

Files have separate trust roles:

- `events.jsonl` is the only trajectory content visible to a judge.
- `state.json` is the point-in-time acceptance and Context snapshot. An item is
  visible only when `available_at <= event.timestamp`.
- `labels.json` is evaluator-only gold established from later user correction,
  repository facts, Evidence, and Outcomes.
- `provenance.json` is a sanitized source ledger for every event and state
  candidate. It binds stable source identities and locators to the earliest
  authentic availability time without retaining raw thread or session IDs.
- `curation.json` records why each excerpt was selected and the later basis for
  its labels. Every acceptance-evidence excerpt also records the earliest
  authentic source Outcome time and its stable Outcome reference. Tests reject
  events that predate this source ledger. Replay never loads curation into a
  judge request.

Tests require every event timestamp and every state `available_at` value to be
backed by this source ledger. Acceptance candidates preserve real source Ticket
acceptance IDs; Context candidates point to actual source, Context, decision,
or PR records. The ledger is evaluator-only and never enters a judge request.

The locators are executable without checking private identifiers into Git:

- `peel-git://` resolves an immutable commit, repository-relative path, and
  blob in a Peel checkout; the commit's committer time authenticates
  `source_available_at`.
- `peel-record://` resolves a named local Ticket or Outcome and verifies the
  SHA-256 of its exact bytes. This preserves the unfinished-logo case, whose
  semantic records intentionally remain outside Git in the source project.
  Outcome availability is authenticated by its `closed_at` value.
- `peel-codex-turn://` is SHA-256 over UTF-8
  `<raw-thread-id>:<raw-turn-id>:<phase>`. The verifier matches it and the
  authoritative turn timestamp against an ignored local turn index, so the
  checked fixture never contains either raw ID.

Resolve all 36 entries against the source checkout and an ignored local index:

```sh
npm run verify:peel:provenance -- \
  --source-repo /path/to/Peel \
  --codex-turn-index .local/peel-turn-index.json
```

Every event is labeled for all four Phase 0 families. The corpus intentionally
contains positive, negative, and hard cases: transient versus durable facts,
activity versus acceptance evidence, Context supersession, independently
schedulable work, a protected human review boundary, and a semantic-completion
versus Git-durability mismatch.

Run the local mechanical baseline:

```sh
npm run replay:peel
```

Run the live JEV benchmark only with the local ignored Gateway credential:

```sh
npm run benchmark:peel:jev
```

The live run is an experiment, not calibration or a productization decision.
It performs a synthetic connectivity preflight, then spaces Gateway requests
to stay below the observed provider rate window. Generated SQLite audits stay
under `.local/` and are never committed.

Compare the accepted JEV audit with Claude Haiku 4.5 through `claude -p`, without
calling JEV again:

```sh
npm run benchmark:peel:compare
```

The comparison sends only `events.jsonl` plus point-in-time `state.json` through
the same policy questions. Labels, curation, and the provenance ledger remain
evaluator-only. Haiku decisions are schema validated, rate limited, retry
bounded when the transport exposes a transient status, and checkpointed under
ignored `.local/` state for safe restart. The CLI transport disables tools,
Skills, settings, and session persistence and runs outside the repository.
It uses the same questions, confidence thresholds, graph, and point-in-time
inputs as the accepted JEV run, with a separately reported 60-second CLI
deadline so subprocess startup does not become a quality label.

The official TypeSafe transport has a separate, ignored, restartable benchmark:

```sh
npm run benchmark:peel:jev:direct
```

It sends the same sanitized `events.jsonl` and point-in-time `state.json` to
`api.typesafe.ai`; labels, curation, provenance, and secrets stay local. Because
this is a distinct data destination from Gateway or Claude CLI, execute it only
after that destination is explicitly authorized.
