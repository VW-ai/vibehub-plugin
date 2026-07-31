# Canonical lifecycle

Allowed state transitions:

```text
machine-validated create -> active
draft -> active | deprecated   # exceptional legacy/authoring records only
active -> stale | superseded | deprecated
stale -> superseded | deprecated
superseded | deprecated -> terminal
```

- Ingest builds candidates in memory, machine-reviews them, and writes passing
  canonical Specs directly active.
- `active` means canonical availability, not human authorship or ratification.
- Confidence, evidence, provenance, conflicts, and explicit gates carry
  uncertainty and authority.
- Amend creates an immutable revision without changing state.
- Mark stale only with evidence that current truth may no longer hold.
- Supersede is `OLD -> NEW`; the replacement must already be canonical active.
- Deprecate is the normal rejection/withdrawal operation. Never delete an ID or
  revision to hide it.
- Mapping activation is independent from canonical Spec creation. It changes only
  the active mapping pointer through compare-and-swap.
