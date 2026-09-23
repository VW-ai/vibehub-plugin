# Synthetic replay fixture

Five invented events exercise all four decision families. No private session
data is included. Labels are hand-authored for the fixture and read only by the
evaluator; they are never model inputs. This is a pipeline smoke test, not a
real-world benchmark or evidence that the productization gate passed.

The `peel/` directory is a separate, deliberately selected real-trajectory
fixture. It contains 20 sanitized semantic excerpts and point-in-time state
from the Peel project, plus evaluator-only labels, a sanitized provenance
ledger, and curation notes. See
`peel/README.md` for its provenance, privacy boundary, and replay commands.
