# Claude Code host procedure

Claude Code loads project instructions, plugin hooks, MCP configuration, and
skills at session boundaries. After a changeful apply, ask the user to restart Claude Code in the exact checkout that was inspected and applied. A session in
another worktree, the Git common root, or a parent directory is not equivalent.

After restart:

1. Wait for the new session's startup hook to run naturally.
2. Re-run setup status for the same exact checkout.
3. Treat Connected as proven only when status reports the post-instruction host
   handshake. A running Claude process or verbal acknowledgement is not proof.
4. Perform authentic work that calls a meaningful query or ingest workflow.
5. Re-run status and use only its evidence to report Activated.

If status remains waiting, verify the user restarted Claude Code in the exact
checkout and that the new session began after the current instruction blocks.
Do not synthesize a hook event, edit session rows, or switch to another checkout
to make the proof pass.

Real Claude host operation can send project context through configured tools.
Obtain user approval and confirm the target path before crossing that boundary.
