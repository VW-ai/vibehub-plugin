---
name: vibehub-mod
description: Explain the VibeHub mod that Claude Code loads from this folder. Use when the user asks how to mention a Ticket with #, what /vh shows, or why a Ticket's context reached the conversation.
disable-model-invocation: true
---

# VibeHub Mod

This folder is also a Claude Code plugin. Claude Code loads it from the skills
directory in the terminal and the desktop Code tab, version 2.1.287 or later
in the terminal and 2.1.286 or later on the desktop. Other agents can ignore
it: nothing here asks an Agent to run anything.

## Automatic dashboard entry

Before the first user-facing operation in an opted-in VibeHub session, follow
`../vibehub-core/contracts/session-entry.md`: run the bundled `vh-start.mjs`
entry helper, reuse the session's existing dashboard when available, then
continue this Skill. Do not ask the user to start a separate dashboard.
Subagents reuse the parent's entry; a user request to keep it closed wins.

> If `../vibehub-core/scripts/vh.mjs` is missing, the install was partial. Run
> `npx skills add VW-ai/vibehub-plugin -s vibehub-core` (or rerun it for every
> Skill); the mod reads Tickets through that helper.

The mod writes nothing:

- Typing `#` in the prompt offers unfinished Tickets by title.
- A message that mentions `#ticket-id` carries that Ticket's record and
  context refs to the model beside the prompt. A repeat mention in the same
  session adds a one-line reminder.
- `/vh` opens a pane grouped into In progress, Ready, and Blocked, with the
  selected Ticket's details and a button that inserts the mention. Without a
  pane, as in `claude -p`, it lists the Tickets as text.

Record progress through `$vibehub-ticket`, not through this mod. See
`README.md` beside this file for running and checking it.
