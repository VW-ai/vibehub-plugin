# Install VibeHub

VibeHub is a Skill-first plugin. Installation copies manifests, Skills,
schemas, dependency-free helper scripts, and the local graph UI assets. It does
not install a global CLI, MCP server, hook process, database, native module, or
daemon. The read-only UI host starts in the foreground when a Ticket lifecycle
moment needs a visual review, or when explicitly requested as a fallback, and
exits with its launcher process.

## Requirements

- Claude Code or Codex with plugin/Skill support
- Node.js 20+ for bundled validation scripts
- Git for history, collaboration, and rollback

## Start in a repository

Describe the concrete deliverable, then tell the Agent:

> Start this with VibeHub.

Ticket Plan owns this entry. When the exact checkout has not been initialized,
it uses VibeHub Setup first and then resumes the same development cycle. The
user does not need to choose a Skill or issue another command.

Before writing, setup inspects common overlapping surfaces:

- `AGENTS.md` and `CLAUDE.md`
- `docs/` and repository knowledge folders
- `.github/copilot-instructions.md`
- project-local Claude/Codex skills
- existing memory, context, decision, ADR, or note systems
- similarly named “record”, “remember”, or archive commands

When overlap exists, setup asks for one choice:

- **dual-write** — keep the current system and update its command to write both
  stores; or
- **VibeHub-only** — stop old writes after an explicitly reviewed one-time
  conversion.

If the user does not grant write permission, VibeHub can still read and advise,
but cannot claim a complete development cycle.

After consent, setup creates only:

```text
.vibehub/rooms/
.vibehub/tickets/
.vibehub/evidence/
.vibehub/outcomes/
```

and a small managed project-instruction block. Validate with:

```bash
node <plugin>/skills/scripts/vh.mjs project validate --repo <repository>
```

## Ticket graph presentation

Ticket Skills proactively present the focused graph after planning, at a
protected human boundary, after closeout, and for PR review. Routine execution
stays quiet. To open the graph explicitly as a fallback, ask the Agent to use
`$vibehub-ticket-review` or launch the bundled helper:

```bash
node <plugin>/skills/scripts/vh-ui.mjs --repo <repository>
```

The default command opens the complete short-lived URL in your normal system
browser. Use the page's **Copy link** control to open that same authorized URL
in another local browser. Keep the `#...` fragment: a bare loopback origin is
intentionally unauthorized. Use `--no-open` only to print the URL for an Agent
or test, `--port <port>` to choose a loopback port, and `--json` for an
Agent-readable launch envelope. The UI reads the repository's checked-in YAML
directly, rejects invalid canonical documents before projection, and exposes
no write routes. Its visual and interaction contract is documented in
[LOCAL_GRAPH_DESIGN.md](LOCAL_GRAPH_DESIGN.md).

## Uninstall

Remove the plugin through the host. Repository Context and Tickets remain
ordinary Git files. Delete them only when you intentionally want to remove the
project history; Git can restore earlier versions.
