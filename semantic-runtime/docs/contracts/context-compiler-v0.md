# Reproducible Context Compiler v0

`LocalContextCompiler` turns one permission-checked `LocalQueryEngine` window
into an immutable, addressable `ContextPackage`. The package is informational:
it can recommend silent, soft, or hard presentation, but it cannot mutate a
host prompt, enqueue work, or elevate authority.

## Public entry

```js
const compiler = new LocalContextCompiler({ query_engine });
const result = await compiler.compile(context, {
  schema_version: 1,
  query,
  compiler: {
    policy_id: 'runtime-context-package',
    policy_version: '1',
  },
  window_profile: {
    profile_id: 'codex-large',
    context_window_tokens: 131072,
    reserved_output_tokens: 16384,
  },
  capabilities: {
    callbacks: false,
    hard_injection: false,
    markdown: true,
    source_links: true,
  },
  budget: { max_tokens: 16384 },
  injection: {
    requested_mode: 'soft',
    reasons: ['task_context_available'],
  },
});
```

The Compiler follows the Query cursor to completion. Every page is checked
against the same request, selection, rank, consumer, coverage, and window
identity. `LocalQueryEngine` rechecks the current local credential, source
access, Project selection, Graph heads, and invalidation fence before each
page is returned. A race refuses the package rather than returning a prefix.

## Package layers

The package always uses this order:

1. `governing_context`
2. `task_contract`
3. `decisions_and_constraints`
4. `working_state`
5. `evidence`
6. `unresolved`
7. `other_exploration_awareness`
8. `source_pointers`

Mandatory canonical Authority remains in the first layer. Current Ticket
contracts, own-exploration Context, evidence, questions, and atomic conflicts
retain their roles. Context selected from another exploration is always placed
in the awareness layer; rank or Judge confidence cannot promote it to governing
state. Conflict variants remain plural and have separate exact pointers.

Canonical records and Runtime Context with equivalent normalized meaning are
deduplicated only within the same layer. The retained item collects every
source pointer. This prevents duplicate text from spending the consumer budget
without erasing provenance or treating awareness as adoption.

## Budget accounting

`max_tokens` uses the same conservative contract as the bounded Query: one
UTF-8 byte counts as one upper-bound token unit. This is stricter than common
provider tokenizers and therefore never claims provider-specific token
precision. It makes the bound deterministic without loading a host tokenizer.

The Compiler first reserves the immutable package header, Graph/source/shared
base pins, governing Authority, conflict plurality, every source pointer, and
an omission record for every optional body. If that envelope does not fit, it
returns `context_package_budget_too_small`. It then materializes optional bodies
in layer and Query-rank order. Bodies that do not fit remain exact pointers with
`text_budget` omissions. Semantic duplicates carry `semantic_duplicate` and a
`duplicate_of` reference.

## Identity and later retrieval

`package_id` binds:

- the normalized complete Query result and its request/rank digests;
- selected Graph commits, source watermarks and fence;
- own and related exploration identities;
- selected shared bases and whether a newer base is available;
- Query lineage, including adoption links;
- compiler policy/version, host capabilities, window profile and budget;
- the final layer, omission and pointer materialization.

Ephemeral Query window IDs and cursors are excluded, so the same authorized
snapshot and compiler request produce the same package identity. `used_tokens`
is measured metadata and is excluded from the identity calculation; the
validator recomputes both the package identity and exact serialized size.

Exact semantic and canonical pointers remain immutable after later Graph
changes. A consumer resolves them through a fresh Query/read operation using
the package pins. Historical selection does not restore historical access:
current credential and source permission are checked again and a revoked
source remains unavailable.

## Presentation boundary

The recommendation is data with `executable: false`. A requested hard notice is
downgraded to soft when the host lacks hard-injection capability, the selected
state has unresolved conflicts, freshness is unknown, or required shared state
is unavailable. Host adapters and the later session-delivery capability decide
whether and when to present a package. The Compiler never calls a callback,
edits conversation state, or returns an executable `WorkRequest`.

## Verification

```sh
node --test test/context/context-compiler.test.mjs
```

The integration fixture exercises real SQLite, Graph, Exploration, canonical
source and Query paths. It covers two model-window profiles, deterministic
budgeting and deduplication, Project Authority and Ticket materialization,
related-exploration awareness, atomic conflicts, stale shared bases,
unavailable canonical state, no-callback consumers, adoption lineage, later
Graph changes, and permission revocation. It is deterministic and makes no
model or network call.
