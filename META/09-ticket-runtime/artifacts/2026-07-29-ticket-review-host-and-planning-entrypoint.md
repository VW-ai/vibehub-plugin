# Ticket Review Host and Planning Entrypoint V0

Status: implemented first human-review surface and Ticket-planning
intelligence for the initial repository dogfood loop.

## Outcome

The repository now has two connected entrypoints:

1. `vibehub-ticket-plan` turns a human-framed deliverable into one honest
   coarse graph-change proposal by backchaining from observable outcomes and
   forward-normalizing the candidate.
2. `vibehub ticket review --proposal <id>` opens one proposal-specific local
   review surface that can record exactly one human authorize/reject decision
   and, after authorization, apply that exact candidate through Core.

The planning Skill treats scenario as a non-canonical planning and review
lens. It creates a Ticket only for a stable outcome with an independent
scheduling, blocking, verification, permission, or retry boundary. It stops at
Planning Fog rather than fabricating leaves and explicitly reports that the
current definition contract is an outline, not yet an executable context
package.

The CLI/Skill dispatch wrapper now prefers the repository's built CLI before a
globally installed `vibehub`, so dogfood operations use the code under review.
The new planning Skill is included in package validation and advertised on the
Codex plugin surface. This closes the first agreed discoverability hygiene
item without adding a second daemon, package, or authority path.

## Review surface

The browser receives one projection derived from
`ticket.proposal.review.inspect`:

- the complete current candidate Ticket graph and direct prerequisite
  relations;
- created/revised/existing truth without invented execution status;
- exact proposal and candidate identities;
- the complete validation-set binding and every validation summary, including
  conclusion, check/finding counts, validator/policy identity, trust, and exact
  receipt identity;
- the Core-derived authority path, eligibility, next action, terminal
  decision, and application receipt when present.

When Core derives `stale`, the host does not overlay the old proposal onto the
new head or label that mixture with the old candidate digest. It shows the
current canonical graph, disables advancement, and directs the reviewer to
replan. If even the current graph is unavailable, state projection fails
closed.

The graph uses deterministic layered layout, orthogonal directed edges,
pan/zoom, fit, a working minimap, causal-cone focus, and a single progressive
Inspector. The default view preserves readable Ticket text instead of shrinking
the whole graph to an illegible overview. Desktop, narrow mobile, keyboard
focus restoration, collapsed disclosure, and long-text wrapping were exercised
in the browser against a disposable proposal. Terminal and stale tones remain
deterministic source states; no human decision was manufactured merely to
produce a screenshot.

This UI does not invent scenario entities, workflow phases, readiness, proof,
or maturity. Its primary readable relationship remains: when this Ticket is
done, which Ticket can execute next.

## Authority and capability boundary

The host is foreground, loopback-only, and bound to one immutable proposal. It
uses:

- an unguessable bearer capability with a 30-minute hard lifetime;
- exact loopback `Host` checks on every route;
- exact same-origin checks, JSON-only input, a 32 KiB body limit, and a strict
  browser field allowlist for mutations;
- no browser-authored principal, provider, basis, validation selection, or
  authority signal;
- a one-shot host-injected authority provider;
- joint Core validation plus host-side verification that the recorded receipt
  belongs to the local session and exactly matches the requested action,
  rationale, provider, principal authentication context, basis, proposal,
  candidate, complete validation-set binding and accepted validation refs, and
  required path;
- terminal capability revocation and server shutdown after rejection or
  successful application. If authorization succeeds but publication needs
  recovery, the host remains available only for that exact authorized
  application.

Automatic application happens only after the exact verified authority receipt.
The default CLI/MCP operation surface still cannot manufacture authority, and
the host refuses delegated-policy decisions rather than treating a browser
click as delegation.

The security claim is deliberately narrow. A click is treated as human intent
under a cooperative local trust model: another process already controlling the
same OS account could operate the loopback browser capability. This is not
cryptographic user presence, WebAuthn, remote multi-user authentication, or a
hostile same-UID security boundary. The review surface exposes this limitation
instead of presenting `host_authenticated` as a stronger guarantee.

## Current verification

- CLI typechecking and production build pass.
- JavaScript syntax validation and packaged Skill validation pass.
- The focused Skill package suite passes.
- Two listener-free host cases pass: graph-display/base-match policy and exact
  local authority-receipt verification. All four loopback integration cases
  typecheck. The original authentication/application loopback cases passed
  before rejection and expiry coverage was added.
- A disposable real proposal exercised authenticated state projection,
  desktop/mobile graph interaction, progressive disclosure, keyboard focus,
  and the packaged visual surface without recording a fake human decision.

The two newest loopback cases cover rejection with no publication and hard
capability expiry. They remain to be executed in an environment that permits
test loopback listeners; this is verification debt, not a relaxed runtime
claim.

## Known non-blocking hygiene

The intent-fenced proposal application path can reconcile its own exact
post-publication crash states. The lower-level plain Git publisher still has
no generic, auditable stale-writer recovery outside one persisted application
intent. A crash can therefore leave conservative writer state that requires
explicit diagnosis. This is a P2 liveness/cleanup follow-up: it does not
weaken read integrity or this proposal-specific apply path and does not block
the first Ticket dogfood loop.

## What remains

The current Ticket definition persists only the outline-compatible outcome,
parent, and direct prerequisites. It does not yet store the complete
executable-context contract, acceptance, capabilities, evidence requirements,
or runtime currentness.

The next canonical Ticket graph therefore begins with those outcome boundaries
instead of pretending they already exist:

- compile a bounded executable context package;
- derive and conflict-safely claim a ready Ticket;
- bind a durable Run to the exact claim, Ticket definition, and graph;
- record traceable run evidence without self-asserted completion;
- unlock downstream work only after accepted verification;
- preserve deviations and route protected decisions without false completion;
- expose one agent-facing orchestration entrypoint;
- prove the loop with a fresh Agent in a real repository.

Publishing that bootstrap graph still requires an actual human decision in the
review host. Conversation assent, this artifact, and machine validation are
not substitutes for that authority receipt.
