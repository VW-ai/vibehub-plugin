# Entering VibeHub

The unified dashboard is a built-in VibeHub feature. Choosing or resuming a
VibeHub workflow starts it automatically; users never need a separate dashboard
command or another approval. Installation, a mere mention of VibeHub, ordinary
chat, and unrelated implementation do not trigger entry. A user who asks to
keep the dashboard closed overrides automatic presentation.

On the first user-facing VibeHub operation in the current agent session:

1. Reuse a known live dashboard from this session. Carry its complete URL and
   the already chosen project roots forward; do not scan ports or create a
   durable host registry. Subagents inherit that session context and do not
   launch another dashboard or open another tab.
2. Run the bundled entry helper before the requested VibeHub operation:

   ```text
   node ../vibehub-core/scripts/vh-start.mjs --repo <current-checkout> --json
   ```

   Resolve the helper relative to the calling Skill directory. Add repeated
   `--root <projects-directory>` for project locations already selected by the
   user in this session. The current checkout is always included, along with
   registered worktrees; unrelated home directories are never scanned by
   default. Carry the existing dashboard URL with `--reuse-url <complete-url>`
   when known. The helper verifies its capability and scope before reusing it;
   an expired or unavailable host is replaced. The existing personal-hub config
   pointer connects personal goals automatically when present. An explicit
   `--personal-store <path>` takes precedence.
3. A new host opens the browser automatically and returns its URL, then stays
   in the foreground. Keep it alive through the agent's process/session tool.
   A reused host returns `reused:true` without opening another tab. No user
   command, database initialization, Ticket creation, or background daemon is
   required. The manual dashboard command is only a troubleshooting fallback.
4. Continue the user's requested work immediately after the launcher reports
   ready; do not wait for dashboard interaction. If the process or browser
   cannot start, mention the limitation briefly and continue in conversation.
   Dashboard availability must never gate the work or constrain model output.

Later lifecycle presentations reuse this host and tab. The dashboard's
workspace-scoped links open the requested checkout's Contract, Evidence, or
Room view inside the same host. Routine work does not repeatedly raise the
browser. In a new session without a known live URL, run the entry helper again.

## Local work is the default

GitHub is opt-in. Using VibeHub, creating a goal, executing a Ticket, or recording
Context does not authorize a push, PR, Issue, remote sync, or sharing records.
New `project init` records are ignored by Git. Keep temporary planning inputs
and copies inside the ignored `.vibehub/` folder or outside the checkout; do
not leave private JSON batches or summaries among files staged for code. Never force-add them, remove the
local exclusion, or include private planning text in a code PR without explicit
sharing authorization. A request to publish code does not implicitly include
private goals, Tickets, Context, Evidence, or Outcomes.

Use `project sharing --repo <root>` to distinguish new local records from
existing tracked records. Tracked records remain shareable through normal Git
commits; ignore rules cannot make them private. Keep private information in new
ignored records rather than editing shared documents with it. Preserve existing
tracked data and published history. GitHub features are optional and local
planning, execution, validation, and dashboard use do not require them.
