# Acceptance and Contract revision identity

VibeHub's semantic contract is append-only. `ticket_id` and `acceptance_id` are
stable logical names; positive integers are human-readable revisions; a
`sha256:` identity is the immutable machine binding.

`revision-contract.mjs` is the executable source of truth. It recursively
sorts object keys, preserves array order unless a field-specific rule below
sorts it, serializes the resulting value as compact JSON, hashes its UTF-8
bytes with SHA-256, and prefixes the lowercase digest with `sha256:`.

An Acceptance identity hashes:

- `ticket_id`, `acceptance_id`, and `revision`;
- `criterion` and explicit/default (`agent`) `authority`;
- exact `derived_from` logical ID and revision pairs, sorted by ID then
  revision.

It excludes active/retired selection, `presentation`, Ticket metadata,
formatting, filenames, Git commits, and repository position. Consequently a
semantic correction appends the next revision under the same logical ID,
while display-only copy changes do not.

A Contract identity hashes its `ticket_id`, revision, and the complete set of
exact Acceptance references (`acceptance_id`, revision, identity), sorted by
ID then revision. It excludes the active Contract selector. Reverting to older
membership therefore appends a new Contract revision; it never moves the
selector backwards or mutates history.

Use `ticket revise` (or `appendTicketContractRevision`) as the canonical
mutation path. A semantic change to an existing responsibility appends its
next revision; a separately passable responsibility starts a new logical ID
at v1; split/merge retires predecessors and gives new IDs exact
`derived_from` references; no-longer-applicable responsibilities retire
without fabricated lineage; `presentation_changes` alter no identity.

Native closeout may cite only Evidence bound to the exact Acceptance revision
inside its Contract. Reconstructed closeout is different in one deliberately
narrow way: migration preserves its immutable legacy `evidence_ids`, including
older supporting references, rather than deleting or silently rebinding them.
Those mismatched references remain readable history and grant no revision
coverage. Human authority is never relaxed: every accepted human Acceptance,
native or reconstructed, needs at least one cited human-origin Evidence record
bound to that exact revision and identity.
