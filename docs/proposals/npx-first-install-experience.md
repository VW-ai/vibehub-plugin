# Proposal: npx-first install experience

Ticket: `ticket-propose-npx-first-install-experience` · 2026-08-22

## The problem, reproduced

`npx skills add VW-ai/vibehub-plugin` already works today — and produces a
broken install. Run in a scratch project on 2026-08-22 (transcripts checked in
as Evidence):

| Target | Command | Copied | Missing |
| --- | --- | --- | --- |
| Claude Code | `npx skills add VW-ai/vibehub-plugin -a claude-code -s '*' -y` | 11 skills → `.claude/skills/<name>/` incl. `agents/`, `references/`, `assets/` | `skills/scripts/`, `skills/contracts/` |
| Codex | `npx skills add VW-ai/vibehub-plugin -a codex -s '*' -y` | 11 skills → `.agents/skills/<name>/` | same |

skills.sh copies every directory that contains a `SKILL.md` (walking
`skills/` up to three levels) and nothing else. Our 11 `SKILL.md` files make
45 references to `../scripts/vh.mjs`, `../scripts/vh-ui.mjs`, or
`../contracts/*`; after the copy every one of them dangles. An Agent that
follows the Skill gets `Cannot find module …/skills/scripts/vh.mjs`.

Anyone can already find the repo on skills.sh, so this is a live defect, not a
future feature.

## What "npx-first" tools actually do

[heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) — the
owner's reference — splits into two layers:

- **Agent layer:** `npx skills add heygen-com/hyperframes`. Skills are plain
  `skills/<name>/SKILL.md` folders; one router skill installs the rest on
  demand.
- **Tool layer:** `npx hyperframes init|lint|check|preview|render`. Every
  Skill says *"Run commands as `npx hyperframes …` unless project instructions
  provide a wrapper."* Skills are pure text; the executable is fetched by npx.

So the Skill text never depends on a file next to it. That is the property we
lack.

## Paths compared

### A. Self-contained skill tree (skills.sh-compatible layout)

Make the shared helper travel with the skills under skills.sh's own rules:
move `skills/scripts/` and `skills/contracts/` into one folder that *is* a
skill, e.g. `skills/vibehub-core/` with a one-line `SKILL.md` ("Shared helper
and contracts for the VibeHub Skills; nothing to invoke"), and repoint the 45
references to `../vibehub-core/scripts/vh.mjs` and
`../vibehub-core/contracts/…`.

| | |
| --- | --- |
| User types | `npx skills add VW-ai/vibehub-plugin` (all hosts) — marketplace commands keep working unchanged |
| Lands on disk | 12 folders under `.claude/skills/` or `.agents/skills/`; relative paths resolve because siblings are copied together |
| Helper reachability | by construction; same relative layout in the marketplace bundle, so one layout serves both paths |
| Version skew | none — skill text and helper ship together |
| Network | GitHub fetch at install only; zero afterwards |
| Upgrade | `npx skills update` or host marketplace upgrade; `project compatibility` unchanged |
| Cost | rename + sed across 11 SKILL.md, tests, `build-plugin-artifact`/`verify-plugin-artifact`, plugin manifests; ~1 focused Ticket |
| Risks | a 12th "skill" appears in agent listings (mitigated by its description); `-s <one-skill>` partial installs omit core — document "install all" |
| Boundary | fully inside `decision-speed-first-skill-plugin`: still no CLI, daemon, or registry |

**Tested:** skills.sh copies a skill folder's subdirectories intact (seen for
`agents/`, `references/`, `assets/`), so a `vibehub-core/scripts/` folder
would arrive. Not yet tested: the renamed layout end-to-end (that is the
implementation Ticket's first check).

### B. Published npm package used by Skills and humans

Publish the helper as a package; Skills say `npx <pkg>@^0.8 ticket graph …`
and humans get `npx <pkg> init [--github-issues]`.

| | |
| --- | --- |
| User types | `npx skills add VW-ai/vibehub-plugin` then `npx <pkg> init` |
| Lands on disk | Skills (text only) in the agent dir; helper in the npx cache (`~/.npm/_npx`), not in the project |
| Helper reachability | via npx on every call; Skills need a "use `../scripts/vh.mjs` if present, else `npx <pkg>`" wrapper rule like hyperframes |
| Version skew | real: skill text pins a range; release script must bump both. Old skills + new package is the failure mode |
| Network | first call per machine and per version; ~1 s npx resolution on every call afterwards |
| Upgrade | npm publish becomes a release step (today release is GitHub-only by decision, see `docs/RELEASE.md`) |
| Cost | npm package scaffold, publish automation + secrets, wrapper rule in 11 Skills, `init` command, docs; ~3 Tickets |
| Blocker | **the name `vibehub` is taken on npm** (unrelated "Command line interface for VibeHub", v0.2.2, last modified 2025-09-16). `@vibehub/cli` is unpublished but needs the `vibehub` npm org, whose availability is untested. `vibehub-plugin` is free (untested) |
| Boundary | npx is not a global install, but it is a second distribution channel with its own registry, secrets, and cache — outside the current "GitHub-only, dependency-free" release decision |

### C. Marketplace-only, skills.sh declared unsupported

Keep today's three commands; add a note that skills.sh installs are
unsupported.

| | |
| --- | --- |
| Cost | one README line |
| Effect | none on the defect — skills.sh cannot be opted out of, so broken copies keep happening silently |

## The GitHub Issues mirror as a setup-time option

Independent of A/B/C, `vibehub-setup` (and any future `init`) gains one
optional step, asked once, after `.vibehub/` is initialized:

1. Detect `git remote get-url origin` matching `github.com`.
2. Ask: *"Mirror Tickets to GitHub Issues? Adds one workflow and one script;
   runs only in GitHub Actions on push to main; nothing for an Agent to run."*
3. On yes, copy two files verbatim from the installed skill tree
   (`vibehub-core/templates/github/sync-issues.yml` →
   `.github/workflows/sync-issues.yml`, `…/sync-github-issues.mjs` →
   `scripts/sync-github-issues.mjs`) and rewrite the script's import of the
   helper to the installed path. Nothing else.
4. Setup's Evidence records the copy. No Skill, instruction block, or hook
   asks an Agent to run or check the sync afterwards — the
   `decision-github-issues-are-a-read-only-ticket-projection` rule stands.

The script currently imports `../skills/scripts/vh.mjs` relative to this repo;
under A it imports from `vibehub-core`; under B it would `npx` the package.
The workflow needs no change.

## Recommendation

**Path A now.** It fixes a live defect, gives the one-line
`npx skills add VW-ai/vibehub-plugin` the owner wants across every
skills-capable host, keeps the no-network, no-registry, no-CLI boundary, and
costs one Ticket. The marketplace path keeps working from the same layout.

**Path B deferred, not rejected.** It is the right move only when a human —
not an Agent — needs to initialize a project outside any agent session. Today
the canonical entry is an Agent saying "Start this with VibeHub", so `init`
for humans has no demonstrated demand; and the npm name problem means B also
needs a naming decision. Revisit when someone asks for `init` in a terminal.

**Path C rejected**: it documents the defect instead of fixing it.

What A deliberately does not do: no `npx vibehub init`, no npm publish, no
router skill, no change to the Ticket lifecycle.

## The question for the owner

> Take path A (self-contained `vibehub-core` skill folder, skills.sh becomes a
> supported install path, GitHub mirror offered once during setup), and defer
> the npm-published `init` until a human asks for it?

Answering "A" lets the implementation Ticket be replanned to firm with exact
acceptance. Answering "B" needs one more choice first: the npm package name.
