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
# Canonical Specs

- [intent-live-shell-001] (active) Build the daily dogfood shell for activation,
  live workspace and honest context feedback.
