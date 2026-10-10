# VibeHub mod for Claude Code

An early Claude Code mod that brings VibeHub Tickets into the terminal and
desktop Code tab. It reads Tickets through the sibling `vibehub-core` helper
and writes nothing.

- Type `#` in the prompt to pick a Ticket by title. The typeahead shows its
  state and ID.
- A message that mentions `#ticket-id` carries that Ticket's record and its
  context refs to the model beside the prompt. The transcript shows only what
  you typed. Mentioning the same Ticket again in a session adds a one-line
  reminder instead of the full record.
- `/vh` opens a pane on the **Graph** view: each unfinished Ticket that waits
  on others, with its prerequisites joined to it (finished ones faded). The
  desktop draws it as an SVG that follows the theme; the terminal draws it with
  box characters. **List** groups every unfinished Ticket into In progress,
  Ready, and Blocked. Selecting a Ticket shows its outcome, constraints,
  acceptance, dependencies, the Tickets it unblocks, context, and recent
  progress, without another read. **Mention in prompt** inserts the reference. Where no pane
  can open, as in `claude -p`, `/vh` lists the Tickets as text.
- The most recently mentioned Ticket is this session's Ticket. The pane marks
  it with a filled dot, and the system prompt names it.

Mobile is out of scope for now.

## Install it

The VibeHub install carries the mod. Claude Code loads any folder under
`~/.claude/skills/` that holds `.claude-plugin/plugin.json` as a plugin, so
after

```bash
npx skills add VW-ai/vibehub-plugin
```

new Claude Code sessions load it as `vibehub-mod@skills-dir`. Check with
`claude plugin list`. To turn it off, run
`claude plugin disable vibehub-mod@skills-dir`. Titles need a project on Ticket
schema 5 or later.

The mod API is early access and changes between Claude Code releases. This
version targets Claude Code 2.1.293.

## Check it

```bash
claude plugin validate skills/vibehub-mod
claude plugin test skills/vibehub-mod
```

For one session from a checkout, use
`claude --plugin-dir /path/to/vibehub-plugin/skills/vibehub-mod`.
