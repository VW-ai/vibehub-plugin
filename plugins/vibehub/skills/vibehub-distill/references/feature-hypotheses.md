# Feature hypotheses

Form features from converging capability evidence, not directory shape.

- **Capability boundary**: name a stable user/system ability with a distinct
  trigger, responsibility and observable outcome. Package/module boundaries,
  entry points and tests support the hypothesis but do not decide it alone.
- **Layer**: project capabilities coordinate multiple domains; feature
  capabilities deliver one coherent outcome; module capabilities implement a
  narrower responsibility. Parent only when the child cannot be explained
  independently of the parent capability.
- **Cross-cutting**: behavior intentionally applies across several capability
  boundaries (auth policy, telemetry, error convention). Represent the feature
  only with direct evidence; do not duplicate file ownership or invent links.
- **Shared infrastructure**: a reusable implementation component is not a
  feature unless its behavior is itself governed/observable. It may anchor
  multiple supported features.
- **Unclassified**: retain files whose purpose or placement lacks evidence.
  Coverage accounting remains honest; never create “misc” merely to eliminate a
  gap.
- **Uncertain analyzable source**: analyzable source uncertainty stays included
  and explicitly unresolved. It is never mechanically excluded, assigned an
  arbitrary anchor, or forced into a nearby capability.
- **Configuration/support**: configuration, bootstrap, migration, build, and
  support files may remain unresolved. Record direct capability evidence when
  it exists; otherwise use no fake feature to make every file appear placed.

Prefer stable purpose names over frameworks. A hypothesis must cite entry/test/
call or authored evidence and state uncertainty. Feature counts, depths and file
sizes are telemetry only.
