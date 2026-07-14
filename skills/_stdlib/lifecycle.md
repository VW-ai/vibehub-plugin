# Canonical lifecycle

Allowed state transitions:

```text
draft -> active | deprecated
active -> stale | superseded | deprecated
stale -> superseded | deprecated
superseded | deprecated -> terminal
```

- Ingest and code inference create drafts/candidates, never active truth.
- Amend creates an immutable revision without changing state.
- Promote is explicit human authorization after the draft is shown.
- Mark stale only with evidence that current truth may no longer hold.
- Supersede is `OLD -> NEW`; the replacement must be canonical active, or the
  same explicitly authorized operation promotes the shown draft.
- Deprecate is the normal rejection/withdrawal operation. Never delete an ID or
  revision to hide it.
- Mapping activation is independent from canonical promotion. It changes only
  the active mapping pointer through compare-and-swap.
