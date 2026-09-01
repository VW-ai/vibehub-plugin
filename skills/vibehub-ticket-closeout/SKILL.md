---
name: vibehub-ticket-closeout
description: Independently adjudicate one lightweight VibeHub Ticket against every acceptance criterion and write its Git-native Outcome. Use after implementation and acceptance-linked Evidence exist.
---

# VibeHub Ticket Closeout

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or reinstall through
> the host marketplace) before continuing; every VibeHub Skill needs that folder.

The closeout Agent must be independent from the executor.

Read `../vibehub-review/references/ticket-lifecycle.json` before acting.
Read `../vibehub-core/contracts/acceptance-authority.md`. A human-authority criterion can be
accepted only when the Outcome references Evidence with `origin: human` that
faithfully records explicit human input. Agent-origin Evidence may support the
record but cannot substitute for that judgment.
Read `../vibehub-core/contracts/ticket-next-action.md`. The normal closeout entry is
`next_action.action: CLOSE_OUT`; full Evidence coverage still requires this
independent adjudication and never creates success automatically.
This Skill owns `closeout-recorded`; it does not own UI launch mechanics.

1. Read the exact Ticket, diff, tests, and all Evidence:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket get --repo <root> --input <id.json>
   node ../vibehub-core/scripts/vh.mjs ticket validate --repo <root>
   ```

2. Decide each current acceptance criterion from reproducible evidence. Do not
   accept an executor's summary as proof.
3. Create one complete Outcome using `../vibehub-core/contracts/outcome.schema.json`.
   `successful` requires every criterion accepted with referenced Evidence.
   Use `partial`, `failed`, or `deviated` honestly otherwise.
4. Persist it:

   ```text
   node ../vibehub-core/scripts/vh.mjs ticket closeout --repo <root> --input <outcome.json>
   ```

5. Read `ticket frontier` back. Only a successful Outcome unlocks direct
   dependents. Follow `closeout-recorded`: ask `$vibehub-review` to
   present the exact Ticket's Log, then report the result and any concrete
   follow-up gap. A durable cross-ticket fact revealed by adjudication is
   delegated to `$vibehub-ingest`, placed in the Ticket's room. Do not create
   speculative parity work.
