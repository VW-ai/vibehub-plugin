# Bounded Context Query v0

`LocalQueryEngine` retrieves one explicitly selected, authorized Context window.
It is the local library boundary between typed Context storage and a later
Context Compiler or host API. It does not scan a whole Project, persist an
index, synthesize an answer, deliver a notice, or modify canonical state.

## Public entry

```js
const engine = new LocalQueryEngine({
  store,
  authority,
  canonical_reader,
  judge_runtime: null, // or the actual same-store LocalJudgeRuntime
});

const result = await engine.query(context, request, { signal });
const next = await engine.next(context, { cursor: result.cursor }, { signal });
```

The exact request names one own exploration and at most two related
explorations. Every selection carries a Graph commit, current/as-of mode,
immutable shared-base pin and heads cursor. The request also pins the current
Project selection version and source fence. It can add up to eight exact
Context revisions, one own one-hop lineage page, exact Ticket/Room/repository
scope, a bounded text query, declared seen refs, freshness requirements, result
and serialized-byte budgets, and an optional Context Judge invocation.

Tenant, Project, actor and actor kind come from the opaque local grant. Caller
text, scores, candidates, ACL claims and implicit `main`/`latest` selectors are
not accepted. A continuation is additionally bound to the original credential
object for this first local slice. Restart, eviction, credential replacement or
changed pins expires it.

## Selected window

Each query inspects one heads page of eight rows for each selected exploration,
up to eight exact refs, one eight-link own lineage page plus root, and up to 16
additional conflict variants. The union is limited to 64 authorized Context
revisions. The response labels coverage as `selected_window` and global recall
as `unknown`; source continuations create a new window and can produce new
ordering.

Every candidate is materialized through the typed Context reader. Current
source access, immutable publication, lifecycle, applicability, owning
exploration, exact selected/current heads, Project pointer, source fence,
canonical records and freshness are checked before text indexing. A final
same-view check runs before return, after optional model work, and on every
ranked continuation. Historical selection never restores historical access.

Own Context and related-exploration notices remain different layers. Related
material does not become governing or adopted. Shared origin and current
Project records remain a separate layer; configured active Authority is
retained independently of local relevance or text matches.

An unresolved conflict is one atomic result unit. The query resolves every
authorized head/competing variant, preserves their individual facts, and uses
the maximum member score only to position the group. It never names a winner.
If all variants fail verified scope the group is excluded; if a required member
cannot be authorized or the group exceeds its bound the query refuses instead
of returning a partial conflict.

## Text and rank

`context-text-v1` is a per-window positional inverted index over already
authorized Context and selected canonical text. It applies NFKC, Unicode
lowercase and maximal Unicode letter/number/underscore tokens. `all_terms`
intersects postings; `phrase` requires contiguous positions. Field boundaries
are token separators. CJK without separators is therefore one token. The index
is limited to 256 KiB and 65,536 postings. Capacity failure is explicit and
falls back to exact/scope/graph/recency ranking; unknown implementation errors
still refuse.

`context-rank-v1` is pure and deterministic. Fixed integer factors cover exact
selection, verified scope, text terms, lineage, immutable publication recency,
declared novelty, role consequence, same-exploration text redundancy and an
optional captured Judge sign. Local Context always has zero governing-authority
credit. The sanitized replay input omits Context text and transition rationale;
replaying it reproduces the order and rank digest.

Text mismatch gives zero text credit but does not hide a non-text Context
candidate. Embeddings are explicitly `not_configured` in this slice.

## Optional JEV relevance

A supplied Judge must be the actual `LocalJudgeRuntime` created with the same
store and authority objects, canonical configuration digest and authenticated
scope. This binding is private and fixed; `instanceof`, JSON or a replacement
method cannot impersonate it.

At most eight baseline-ranked, own, current, noncontested eligible Context heads
enter one `evaluateContext` call per window. Query text is not model event text.
Related, historical, contested, oversized and other unselected candidates stay
visible with a `not_evaluated` reason. A confident positive contributes `+30`
to returned target refs and a confident negative contributes `-30` to every
sent ref. Deferred, refused and low-confidence results contribute zero.

Missing credentials, provider refusal, timeout or low confidence can return a
freshly reauthorized local ranking with explicit degradation. Local grant,
source, head, Project or fence changes refuse the whole response. `next` never
reruns the model.

## Budgets and verification

`token_budget` is deliberately conservative serialized UTF-8 byte accounting,
not a provider tokenizer estimate. Exact Authority/conflict/provenance/pin and
rank metadata must fit first. Candidate text may become an explicit pointer;
mandatory metadata never disappears silently. At most 16 completed windows
and 8 MiB of serialized retained material are kept per engine process.

`node --test test/query*.test.mjs` covers real disposable Git/SQLite selected
Context, canonical Ticket/Room/repository scope, adoption, conflicts, full-text,
replay, pagination, budgets, provider fallback and post-model races. Ordinary
verification needs no credential and makes no network call.

`npm run check:jev:query` is a separate opt-in check using a locally supplied
`TYPESAFE_API_KEY`. It makes exactly two one-attempt synthetic TypeSafe calls
through `LocalQueryEngine -> LocalJudgeRuntime.evaluateContext`: one relevant
and one unrelated event. It reports the actual labels, score changes, hashes,
latency and observed-or-unknown usage honestly. It does not retry disagreement,
read private traces, promote Context or claim global retrieval accuracy.

The [2026-09-22 measurement](measurements/jev-query-20260922.json) used official
`jev-1.13.0`. Both expected labels matched: the relevant Context score changed
from 16 to 46 and the unrelated Context from 16 to -14. Model latency was
338–418 ms; observed cost was unavailable. This is a two-case composition
smoke, not a retrieval-quality benchmark.
