# Quality gates

## Hard integrity — core decides

Repository-scoped identity, lifecycle transitions, relation endpoints/cycles,
canonical paths, immutable revisions, idempotency, sealed inventory partition,
valid leases, candidate freeze, checksums and activation CAS. Never work around
a hard finding in a skill or script.

## Retryable — correct only implicated scope

Unread/lost inventory, expired or failed lease, missing supported candidate, or
a finding whose persisted subject identifies a scope. Reopen only scopes named
by persisted findings, then reconcile again.

## Mechanical exclusion — closed taxonomy

The complete mechanical exclusion taxonomy is exactly, in this order:
`generated_or_dependency`, `binary_file`, `oversize_file`,
`non_regular_file`, `incremental_unchanged`, `incremental_deleted`.
Do not mint synonyms, expand this list in prose, or treat semantic uncertainty
as an exclusion. An analyzable source file whose purpose, feature, placement,
symbol, or claim is uncertain remains included and is reported unresolved.

## Review — human judgment

Low confidence, contradiction, ambiguous placement, possible duplicate,
staleness, replacement choice, promotion, or carry-over of human-authored truth.
Do not auto-resolve these for convenience.

## Experimental metrics — report only

Feature count/depth, files per scope, coverage target, relation ratio, spec
density, confidence distribution, WHY ratio and retry count. ShadowRepo values
are hypotheses; none is a VibeHub gate.

## Packaged artifact isolation

Each fresh validation case owns its own clean HOME, repository, package-manager
installation and packaged plugin root. Set `VIBEHUB_PLUGIN_ROOT` to that
case-local root before initialization and execute the package-manager-created
`node_modules/.bin/vibehub` shim. Never point a case at the shared build artifact
or substitute a handwritten launcher, because either can hide managed-asset or
installation defects and leak state between cases.
