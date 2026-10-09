# VibeHub mod for Claude Code

An early Claude Code mod that brings VibeHub Tickets into the terminal and
desktop Code tab. It reads Tickets through the installed `vibehub-core`
helper and writes nothing.

- Type `#` in the prompt to pick a Ticket by title. The typeahead shows its
  state and ID.
- A message that mentions `#ticket-id` carries that Ticket's record and its
  context refs to the model beside the prompt. The transcript shows only what
  you typed. Mentioning the same Ticket again in a session adds a one-line
  reminder instead of the full record.
- `/vh` opens a pane grouped into In progress, Ready, and Blocked. Selecting a
  Ticket shows its outcome, constraints, acceptance, dependencies, context, and
  recent progress. **Mention in prompt** inserts the reference.
- The most recently mentioned Ticket is this session's Ticket. The pane marks
  it with a filled dot, and the system prompt names it.

Mobile is out of scope for now.

## Run it

The mod API is early access and changes between Claude Code releases. This
version targets Claude Code 2.1.293.

```bash
claude --plugin-dir /path/to/vibehub-plugin/mods/claude-code
```

The VibeHub Skills must be installed (`npx skills add VW-ai/vibehub-plugin`),
and the project must use Ticket schema 5 or later for titles.

## Check it

```bash
claude plugin validate mods/claude-code
claude plugin test mods/claude-code
```
