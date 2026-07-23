# Cross-scope semantic reconciliation

Use one reconciler after independent leased scope writes.

1. Group candidates by proposition/capability plus scope and evidence, never by
   summary similarity alone.
2. Merge duplicate hypotheses only when their normative meaning and qualifiers
   agree; preserve all evidence/anchors.
3. Keep conflicting hypotheses distinct and emit `conflicts_with` review items.
4. Resolve parent proposals from capability containment. Reject cycles and
   “directory parent therefore feature parent” reasoning.
5. Add `depends_on` only when direct evidence shows concrete necessity and the
   breach caused by the target's absence/change. A call/import/contract mention,
   structural overlap, adjacency, or shared anchor is a prompt to inspect; by
   itself it supports at most `relates_to`, and often no edge.
6. Detect cross-scope contracts/conventions and consolidate into one candidate
   with representative bounded anchors. Do not create relations to hit a quota.
7. Preserve human-authored canonical specs separately. Candidate reconciliation
   never amends/promotes them.
8. Compare the finalized candidate index/diff with the active mapping. Route
   removals, placement shifts, conflicts and low support to review before CAS.

Core remains authoritative for inventory partition, endpoints, checksums,
immutability and lost-file findings. The reconciler owns semantic equivalence
and must label inference.
