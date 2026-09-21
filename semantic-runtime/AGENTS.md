# Semantic Runtime development

Read `README.md` for this component's boundaries and the linked PRD and technical
design for product scope. The design files are proposals, not instructions to
implement every phase in one task. Preserve open decisions and advance the
phase the user has actually authorized.

## Component boundaries

- Keep Runtime implementation, dependencies, lockfiles, build/test configuration,
  adapters, and fixtures inside this directory. Root-level CI may invoke its
  commands without becoming its dependency or build owner.
- Do not import implementation code from `../skills/`, `../scripts/`, `../site/`,
  or other sibling components. Do not add reverse imports from those components
  into Runtime internals. Introduce explicit public contracts when integration
  work is authorized.
- Keep semantic core interfaces independent of hosts, model providers, storage
  engines, and concrete adapters. Pass project/source paths explicitly.
- Preserve separate install, test, build, and release paths. Before adding the
  first executable component, add an automated import/dependency boundary check
  for its toolchain and verify the component outside the parent repository.
- Use the existing root `.vibehub/` project records when the user requests that
  workflow. Do not create another `.vibehub/` store here. Existing root Context
  is development input, not a hard-coded Runtime dependency.
- Put generated local state in `.local/`. Do not commit private raw trajectories,
  model credentials, databases, or generated replay output. Use only deliberately
  selected and sanitized test fixtures.

## Product boundaries

- Start from the drafts' offline replay prototype; broader service and host
  integration work needs a concrete follow-up scope.
- Fast semantic judgments create candidate state with provenance. They do not
  declare acceptance success or silently overwrite canonical project records.
- Keep `SemanticJudge` provider-independent. JEV-specific behavior belongs in
  an adapter and must be measured rather than assumed.
- Runtime failure must allow ordinary Agent/plugin work to continue.
- Keep Runtime artifacts and dependencies out of the existing Skill package.
