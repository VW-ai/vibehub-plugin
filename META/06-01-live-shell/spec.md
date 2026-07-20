# 06-01-live-shell — Live Shell

This is the first product iteration after open source.

## Intent

Create a stable page the team can keep open while dogfooding VibeHub. It should
make the underlying mechanism visible without becoming the workflow authority.

## First release scope

1. **Activation**
   - Installed / Connected / Activated.
   - Current repo and exact checkout/worktree.
   - Honest recovery or restart action.
2. **Live workspace**
   - Current Task, Run/session, state and declared/observed scope.
   - Timeline, commit/checkpoint receipts, file activity and handoff evidence.
3. **Context feedback**
   - What VibeHub retrieved.
   - What it captured only as operational evidence.
   - What durable semantics were actually persisted.
   - What remains proposed, queued, waiting or failed.

## Constraints

- Build on stable projection and receipt contracts, not SQLite table shapes.
- The Git semantic-store experiment must not force a UI rewrite.
- Do not reintroduce fixture fallback into the production entry.
- Do not imply that evidence capture equals durable semantic persistence.

## Implemented contract

- `LiveShellSnapshotV1` is the browser-safe projection boundary. Identity is
  canonical `repoRoot` plus exact `checkoutRoot` and host.
- Activation keeps Installed, Connected and Activated as independent proof
  states. Setup, doctor, capture, queueing or an attempted operation do not
  imply activation.
- Workspace authority is explicitly `beta_compatibility`. It projects the
  current task/session, canonical declared scope patterns, observed footprint,
  timeline, workflow receipts and typed receipt coverage.
- Every top-level section carries availability, freshness and typed recovery.
  Missing canonical claim, checkpoint or handoff receipts remain visible as
  unavailable/partial rather than being reconstructed.
- Context feedback classifies retrieval, operational capture, explicit proposal
  and durable mutation separately. Only canonical knowledge mutations may claim
  durable persistence.

## Verification evidence

- Repository-wide `pnpm verify` passes, including production Playwright,
  production-bundle boundary checks, packaged Claude/Codex installation and
  isolated dogfood.
- The production browser suite covers recovery, partial/stale evidence, 900px
  and 760px containment, keyboard focus restoration, accessible focus rings and
  reduced motion.
- A real initialized-repository walkthrough proves Installed, Connected and
  Activated independently, one canonical scope pattern, observed write
  footprint, retrieval receipts and one durable knowledge mutation.
# Canonical Specs

- [intent-live-shell-001] (active) Build the daily dogfood shell for activation,
  live workspace and honest context feedback.
