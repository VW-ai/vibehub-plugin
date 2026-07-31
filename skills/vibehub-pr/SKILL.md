---
name: vibehub-pr
description: Prepare or review a pull request whose code and lightweight VibeHub Context/Ticket YAML should remain aligned. Use when a Ticket branch is ready for GitHub review.
---

# VibeHub PR

1. Inspect the branch diff, current Ticket, Evidence, Outcome, and relevant
   Context. Run `node ../scripts/vh.mjs project validate --repo <root>`.
2. Check code quality and whether the implementation contradicts checked-in
   Context or acceptance. Git merge conflicts and PR review own concurrency;
   do not add a second semantic merge protocol.
3. Keep the PR summary short: Ticket outcome, acceptance evidence, Context
   changes, tests, and known gaps.
4. Use the available GitHub workflow to push/open/update the PR only when the
   user has authorized publication.
