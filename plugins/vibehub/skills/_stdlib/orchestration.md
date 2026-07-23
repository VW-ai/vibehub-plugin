# Orchestration and recovery

Start or resume from persisted dispatcher state, never conversation memory.

- Fan out independent reads.
- Candidate writers may run concurrently only with disjoint leased scopes.
- Each scope writes candidates accepted against its lease token and generation.
- Use one reconciler for the shared candidate set, one finalizer, and one CAS
  activation. Never let parallel workers mutate canonical knowledge.
- Seal inventory before planning scopes. Every included file belongs to exactly
  one leaf scope; analysis scopes own no files.
- After interruption, call `distill.run.status` or `distill.run.resume`, inspect
  persisted scopes/findings, and claim only pending or expired work.
- Correct or retry only scopes implicated by persisted findings. Do not restart a
  cold run merely because some work is unresolved.

Bound every read result. Preserve source references through map/reduce; reduce
prose, never provenance.
