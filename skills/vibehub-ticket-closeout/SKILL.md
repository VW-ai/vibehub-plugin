---
name: vibehub-ticket-closeout
description: Independently adjudicate one lightweight VibeHub Ticket against every acceptance criterion and write its Git-native Outcome. Use after implementation and acceptance-linked Evidence exist.
---

# VibeHub Ticket Closeout

The closeout Agent must be independent from the executor.

Read `../vibehub-ticket-review/references/ticket-lifecycle.json` before acting.
This Skill owns `closeout-recorded`; it does not own UI launch mechanics.

1. Read the exact Ticket, diff, tests, and all Evidence:

   ```text
   node ../scripts/vh.mjs ticket get --repo <root> --input <id.json>
   node ../scripts/vh.mjs ticket validate --repo <root>
   ```

2. Decide each current acceptance criterion from reproducible evidence. Do not
   accept an executor's summary as proof.
3. Create one complete Outcome using `../contracts/outcome.schema.json`.
   `successful` requires every criterion accepted with referenced Evidence.
   Use `partial`, `failed`, or `deviated` honestly otherwise.
4. Persist it:

   ```text
   node ../scripts/vh.mjs ticket closeout --repo <root> --input <outcome.json>
   ```

5. Read `ticket frontier` back. Only a successful Outcome unlocks direct
   dependents. Follow `closeout-recorded`: ask `$vibehub-ticket-review` to
   present the exact Ticket's Log, then report the result and any concrete
   follow-up gap. A durable cross-ticket fact revealed by adjudication is
   delegated to `$vibehub-ingest`, placed in the Ticket's room. Do not create
   speculative parity work.
