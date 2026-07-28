# Ticket intelligence and deterministic substrate

**Status**: Research synthesis. This artifact records evidence and frames the
next decision; it does not ratify the Ticket System architecture.

## Source context

The local library search was entity-first and followed the relations vocabulary
only far enough to compare the relevant design claims.

- `intelligence-as-skill.md` argues for small, insertable units of judgment
  rather than encoding an end-to-end stage as one workflow.
- Matt Pocock's skills are short, scene-focused, and composable. A shared
  `LANGUAGE.md` supplies common primitives while each skill teaches one useful
  intervention instead of taking over the host Agent.
- MyLibrary keeps natural-language knowledge as source, compiles deterministic
  indexes and relations for retrieval, and exposes small `lib-*` skills as
  system-call-like intelligence surfaces.
- Robin avoids reimplementing capabilities already supplied by the host Agent
  and contributes only the irreducible product-specific delta.
- Existing VibeHub doctrine separates `hooks = when`, `skills = how well`,
  `MCP/CLI/Core = deterministic operations`, `storage = truth`, and
  `App = perception and intervention`.
- The determinism boundary should be paid for when replay, validation,
  coordination, authority, graph integrity, or scale requires it—not merely to
  translate one representation into another.
- The skill battlefield analysis treats intelligence and workflow as
  component-level types: a thin workflow shell may invoke intelligence at
  judgment boundaries, while excessive procedural constraint can reduce actual
  performance.
- `lib-search` itself demonstrates the composition: the skill chooses search
  depth, semantic traversal, and stopping conditions; filesystem search and a
  shared relation vocabulary provide mechanical primitives and contracts.

Primary local entities consulted:

- `/Users/waynewang/MyLibrary/library/entities/intelligence-as-skill.md`
- `/Users/waynewang/MyLibrary/library/entities/matt-pocock.md`
- `/Users/waynewang/MyLibrary/library/entities/matt-pocock-skills-repo.md`
- `/Users/waynewang/MyLibrary/library/entities/MyLibrary.md`
- `/Users/waynewang/MyLibrary/library/entities/Vibehub.md`
- `/Users/waynewang/MyLibrary/library/entities/Robin.md`
- `/Users/waynewang/MyLibrary/library/entities/determinism-boundary.md`
- `/Users/waynewang/MyLibrary/library/entities/skill-harness-engineering.md`
- `/Users/waynewang/MyLibrary/library/entities/skill-battlefield.md`
- `/Users/waynewang/lib-skill/_stdlib/relations-vocabulary.md`

## Emerging boundary

### Intelligence surface

Skills should teach an Agent how to:

- recognize when work is a Ticket, elaboration inside a Ticket, or still
  Planning Fog;
- generate, decompose, and improve Tickets within delegated authority;
- retrieve the right Ticket and context at the right depth;
- assess semantic quality, acceptance, authority, and proposed graph mutations;
- execute a Ticket without inventing missing product or technical decisions;
- collect evidence, close a Run, and tend the graph after learning.

These capabilities should remain composable. The host Agent decides when to
invoke them and combines them with its native planning, tool use, and reasoning.

### Deterministic substrate

Core or the Local Runtime should own the guarantees that prompts cannot safely
provide:

- versioned schemas and strict operation validation;
- Ticket identity, revisions, provenance, and idempotent writes;
- graph integrity, lineage, and durable mutation receipts;
- ValidationReceipt, GateDecision, Run, Outcome, and Evidence boundaries;
- derived maturity and operational projections;
- bounded, consistent queries;
- common result and error envelopes for thin CLI and MCP adapters.

### Composition

The intended shape is:

1. the host Agent chooses and composes intelligence skills;
2. skills call small semantic Ticket operations;
3. deterministic operations return facts, findings, and receipts;
4. skills interpret those results and act only within delegated authority;
5. programmatic workflow is added only where integrity, replay, coordination,
   authority, or scale requires it.

This keeps the Ticket System intelligent without making correctness depend on
every Agent remembering an informal schema.

## Decision still required

The next Wayfind decision must freeze the first dogfood ownership and capability
surface across Skill, Plugin, MCP, CLI, shared Core/Local Runtime, and App.
Exact skill names, operation names, transport choices, deployment shape, and
which process is the first canonical writer remain unresolved.
