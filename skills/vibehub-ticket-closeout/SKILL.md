---
name: vibehub-ticket-closeout
description: Independently adjudicate one lightweight VibeHub Ticket against every acceptance criterion and write its Git-native Outcome. Use after implementation and acceptance-linked Evidence exist.
---

# VibeHub Ticket Closeout

The closeout Agent must be independent from the executor.

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
   dependents. Report the result and any concrete follow-up gap; do not create
   speculative parity work.
