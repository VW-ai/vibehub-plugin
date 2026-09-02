# Release version identity

What a declared VibeHub version means, and what had to be decided.

## The failure this answers

An install taken at `648c5f62` sat 143 commits behind `928ed611` — a
restructured Skills tree, a new `vibehub-core`, all eleven `SKILL.md` files
changed, changed migration guidance, replaced Workbench assets. Both declared
`0.8.0`. The host reported *already at the latest version* and did nothing.
Only uninstall-and-reinstall produced current content.

The mechanism is not a host bug. A plugin's identity resolves as: the
marketplace entry's `version`, else `plugin.json`'s `version`, else the git
commit SHA. A plugin that declares a version is compared by that string. A
version that does not move while content moves is a version that lies.

`verify-release-version.mjs` already forces the declarations and the tag to
agree with each other. Nothing forced them to move.

## Options considered

**A. Bump per shipped change.** CI fails when content inside the
`build-plugin-artifact.mjs` allowlist lands on `main` while the declared
version still equals the last published release.

- Release pipeline: one added gate; no change to how a release is cut.
- Contributor: must bump, or explicitly record that a change is not
  user-visible. This is the cost, and it lands on every contributor.
- Host: equal version strings become a reliable claim of equal content.
- Published `v0.x` tags: unaffected.

**B. Pre-release identity on `main`.** Between releases the declared version
carries a distinguishable suffix rather than the last release number.

- Release pipeline: version derivation becomes mechanical; the release number
  is chosen only at release time.
- Contributor: nothing to remember day to day.
- Host: `main` and a release are never confusable.
- Published `v0.x` tags: unaffected.

**C. Declare no version anywhere.** Identity falls through to the commit SHA,
so staleness becomes structurally impossible.

- Release pipeline: `verify-release-version.mjs`'s agreement check loses its
  subject; releases stop having a public number.
- Contributor: nothing to remember.
- Host: always correct, never stale.
- Published `v0.x` tags: `CHANGELOG.md` and the tag series lose their meaning
  as the public identity.

## Decision

**A and B together.** A alone puts the cost on every commit; B alone leaves
releases able to ship changed content under a reused number. Together, `main`
carries a pre-release identity so day-to-day work needs no manual bump, and
the gate ensures a release number never covers two different artifacts.

C was rejected because a public version number is worth keeping.

## The part that reaches users

Updating is never forced. A project may sit on an older version indefinitely;
nothing nags, auto-upgrades, or breaks.

An update that *is* taken is owned end to end: VibeHub restructures that
user's existing project data into the new format rather than reporting that
their format is stale and leaving them to it. On the supported install path
the update command is `npx skills update`, so the obligation attaches there.

Left open deliberately, for the cross-project upgrade Ticket rather than this
decision: whether the restructure is offered by the next Agent session that
opens an affected project, or discovered and driven at update time across
every project on the machine. The first is compatible with
`decision-agent-driven-upgrade-migration` as written; the second would require
amending it, because that decision forbids background conversion.

## Why this is not hypothetical

Surveyed on the owner's machine, 2026-09-01: three VibeHub projects, two of
them write-blocked at `MIGRATION_REQUIRED` — `Undercurrent` at
`format_version: 1`, `nomi` at `0.4-unversioned` with no `version.yaml` and 19
flat context entries — with the owner unaware until the survey was run by
hand.
