# VibeHub Semantic Runtime

The proposed Semantic Runtime is developed in this repository so the existing
project Context and development history remain available alongside the work.
Its implementation is an independent component under `semantic-runtime/`.

The first Phase 0 prototype runs explicit offline trajectories through four
decision families, persists candidate state and decision audits in SQLite, and
compares policy runs against the same inputs. Its core has no dependency on the
existing plugin. Vercel AI Gateway adapters connect `typesafe-ai/jev` and
`anthropic/claude-haiku-4.5` to the provider-independent judge contract. The
real-trajectory value benchmark now has a first curated Peel corpus and a
restartable comparison path, while the broader product-value gate remains open.
The included synthetic fixture still proves pipeline behavior only.

## Run the prototype

Use Node.js 22.13+ (23.x requires 23.4+); CI targets Node 22 and 24. The SQLite
adapter uses Node's built-in `node:sqlite`. The pinned AI SDK is the Runtime's
only production dependency; Acorn is a pinned development dependency for
boundary checks.

```sh
cd semantic-runtime
npm ci --ignore-scripts
npm run verify
npm run verify:standalone
npm run replay -- --events test/fixtures/events.jsonl \
  --state test/fixtures/state.json --labels test/fixtures/labels.json \
  --tenant demo --project auth --dataset-kind synthetic
```

The first curated real-trajectory fixture selects 20 sanitized events from the
Peel project's VibeHub development trace. It keeps event input, point-in-time
state, sanitized source provenance, curation notes, and evaluator-only labels
separate:

```sh
npm run replay:peel
```

This offline baseline produces 80 audited decisions. The live JEV benchmark
uses a separate policy with longer network timeouts and writes only to the
ignored local audit store:

```sh
npm run benchmark:peel:jev
```

Compare that accepted JEV audit with a live Claude Haiku 4.5 run through the
local `claude -p` transport, without calling JEV again:

```sh
npm run benchmark:peel:compare
```

The comparison refuses different dataset, state, label, semantic question,
confidence threshold, graph, or decision input hashes. Transport deadlines are
reported separately: the CLI comparison defaults to 60 seconds because process
startup is part of its measured latency, while the accepted JEV run used its
original deadline. Haiku requests are serialized and paced; transports that expose
429 and 5xx status codes receive bounded retry. Successful schema-validated decisions are checkpointed by
model behavior version and input hash under `.local/`, so restarting calls only
missing decisions. Use a new ignored cache only for a deliberately fresh drift
measurement.

Neither command imports the raw Codex trace. The checked-in fixture removes
thread IDs, local paths, identities, credentials, full tool output, and
unrelated conversation. A real-data label report remains an experiment;
`productization_gate` stays `not_evaluated`.

## Vercel AI Gateway and JEV

Keep `AI_GATEWAY_API_KEY` in the ignored `.env.local` file. The checked-in
examples load that file at process start; they never log the credential.

The requested text-generation example lives at `index.ts`:

```sh
npm run example:gateway
```

It calls `openai/gpt-5.5` and fails if the Gateway returns empty text. The
account behind the key must have access and paid credits for that model.

Run the synthetic JEV contract smoke test with:

```sh
npm run smoke:jev
```

`JevJudge` sends the event text and visible candidate text to Vercel AI Gateway,
pins routing to `typesafe-ai`, and maps JEV boolean probabilities into the
Runtime's `relevant`, `target_ids`, and confidence fields. Relational families
evaluate at most 32 visible targets in one request. `p >= 0.5` selects a target;
the Policy Graph's separately configured threshold still decides whether the
result is ingested, ignored, deferred, or escalated. Zero Data Retention is an
explicit `JevJudge({ zeroDataRetention: true })` option because Vercel limits it
to eligible plans.

`HaikuJudge` sends the identical minimized event and candidate shape through
`anthropic/claude-haiku-4.5` and requests a schema-validated ordered probability
vector. The probabilities are model estimates rather than calibrated equivalents
to JEV probabilities, so comparison uses resulting actions and labeled metrics.
The ignored local report also records bounded Gateway route, token, cost, retry,
cache, and latency observations without storing generated prose.

`ClaudeCliJudge` is the comparison transport when Gateway access to Haiku is
unavailable. It pins `claude-haiku-4-5-20251001`, uses `claude -p` with the same
prompt and JSON schema, disables tools, skills, settings, and session
persistence, and runs outside the repository. Its latency and cost are reported
as Claude CLI observations and are not presented as Gateway route performance.
The quality comparison uses the same semantic policy and point-in-time inputs;
its longer CLI deadline prevents process startup from being counted as a model
classification error.

## TypeSafe direct JEV

`TypeSafeJevJudge` calls the official `@typesafe-ai/sdk` against
`jev-latest`. It maps the same minimized event and visible state into batched
Noul questions and returns the same SemanticJudge decision shape as the Gateway
adapter. SDK logging and retries are disabled; the Runtime's bounded retry layer
owns 429 and 5xx handling so transport behavior stays comparable and provider
error bodies never enter the audit.

Keep `TYPESAFE_API_KEY` in ignored `.env.local`, then run the synthetic check:

```sh
npm run smoke:jev:direct
```

The real Peel benchmark is restartable through an ignored decision cache:

```sh
npm run benchmark:peel:jev:direct
```

That benchmark command sends the checked-in sanitized Peel event and
point-in-time state fixture to the TypeSafe API. Run it only when that
destination is explicitly authorized. It never sends labels, curation,
provenance, or credentials.

After an authorized direct run, compare it with the accepted Gateway audit:

```sh
npm run benchmark:peel:jev:routes
```

The comparator requires the same dataset, point-in-time state, labels, semantic
policy, and all 80 normalized decision inputs. Its ignored report treats latency
and output differences as observations of the two complete routes, including
their adapter/API behavior, rather than a provider-wide speed or calibration
claim.

Use JEV for an offline replay explicitly:

```sh
npm run replay:jev -- --events events.jsonl --state state.json \
  --tenant demo --project auth --dataset-kind synthetic
```

Replay prints a `run_id` and creates `.local/replay.sqlite`. Inspect and compare
runs with:

```sh
npm run audit -- --tenant demo --project auth --run RUN_ID
npm run compare -- --tenant demo --project auth --left RUN_A --right RUN_B
```

Each replay creates a new audit run; exact duplicate events in its input are
processed once. Reusing an event identity with different contents is rejected.
Comparison requires matching tenant, project, normalized events, and state.

The CLI accepts the explicit replay format, not arbitrary Codex/Claude session
logs. [Phase 0 contracts](docs/phase0-contracts.md) documents inputs, policy,
judge adapters, metrics, and remaining work. Only an explicit `--judge jev`
selection makes network/model calls. No host hooks, background capture, context
injection, worker execution, or canonical writes occur in this prototype.

## Design baseline

- [Thought log](docs/01_thought_log_semantic_runtime.md): how the direction evolved.
- [PRD](docs/02_prd_vibehub_semantic_runtime.md): product goals and rollout phases.
- [Technical design](docs/03_tech_design_semantic_runtime.md): architecture and prototype.

These are unchanged copies of the supplied 2026-09-19 drafts. Their proposed
status and open questions remain intact. Sharing a repository is now the chosen
development arrangement; it does not settle the remaining product decisions.

The initial scope remains PRD Phase 0 and Technical Design section 29:
trajectory fixtures, normalization, Policy Graph v0, a replaceable
`SemanticJudge`, a candidate store, and offline replay/audit. The four initial
decision families are acceptance relevance, durable cross-ticket value,
context relevance, and independently schedulable work.

## Isolation contract

| Boundary | Rule |
| --- | --- |
| Implementation | Runtime source, adapters, tests, fixtures, tooling, and design documents live under this directory. |
| Dependencies | Declare dependencies here, with a local lockfile when dependencies are introduced. Do not rely on the root or site's `node_modules`, or add Runtime dependencies to their manifests. |
| Build and tests | Own build configuration and test commands here. CI may invoke both components, but each must be runnable independently. |
| Imports | No cross-directory imports of implementation code between the Runtime and the existing plugin, dashboard, site, or repository scripts. |
| Integration | Connect through documented event/query contracts and explicit adapters. The semantic core receives normalized inputs; it does not reach into a sibling component's implementation. |
| Release | Runtime versioning and release artifacts are separate. Keep this directory out of the existing Skill plugin artifact and preserve ordinary plugin operation without a Runtime. |
| Project knowledge | Reuse the root `.vibehub/rooms/` and related development records. Runtime code must receive project paths explicitly rather than depend on this repository's own records. |
| Generated state | Local databases, raw trajectories, replay output, caches, and credentials stay out of Git. Only intentionally selected, sanitized fixtures and reviewable evaluation results are versioned. |

The local package manifest is private and exposes the core replay API through
one package entry. Concrete JEV and Haiku implementations remain internal
adapters; it does not expose adapter subpaths.
Do not introduce an umbrella workspace tool, shared package, or service merely
to connect two components that happen to share a repository.

## Internal organization

- `src/core/`: host- and provider-independent policy, semantic state, and context logic.
- `src/adapters/`: host, model, storage, and Git/source integrations.
- `test/`: Runtime tests and intentionally selected fixtures.
- `scripts/`: Runtime development and replay tools.
- `docs/`: product and architecture documents.

The core owns its interfaces; adapters implement them. Core code must not import
concrete adapters. Host lifecycle details and model-provider APIs stay in adapters.

`check:boundaries` parses ESM imports, rejects cross-component imports, core-to-
adapter dependencies, undeclared/parent dependencies, source symlinks, and
computed imports. It checks `index.ts`, `src/`, `scripts/`, and `test/`; it is a development
dependency check, not a security sandbox. `verify:standalone` copies just the
component's source, policies, tooling, fixtures, and manifests to a temporary
directory, installs from its own lockfile, and repeats verification there.

CI runs this component as a separate job. Plugin artifact verification also
rejects a bundled `semantic-runtime/`. Review any future reverse integration
from the plugin against the public contract instead of importing internals.

## Relationship to the current plugin

The existing plugin's dependency-free distribution boundary still governs the
plugin. This separate development directory is where the proposed Runtime's
store, judge, and later service integrations may be explored. Sharing existing
domain concepts does not authorize importing the plugin's internal helpers.

Git continues to provide source/artifact history and version identity. Runtime
candidate state remains distinct from canonical project records. The drafts
defer long-term canonical ownership and the final deployment model; neither is
decided by this directory layout.
