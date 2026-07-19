---
name: vibehub-setup
description: Set up, onboard, connect, or activate VibeHub for an exact project checkout. Use when a user asks to configure VibeHub in a repository, inspect onboarding health, repair a partial setup, or prove Installed, Connected, and Activated state.
---

# VibeHub Setup

Onboard one exact checkout through deterministic setup receipts. Keep discovery,
host interpretation, recovery choices, and next-step judgment here; let the CLI
own all project and runtime mutations.

## Prerequisites

1. Always read `references/onboarding-contract.md` before any setup operation.
2. Read `references/claude-code.md` only when the active host is Claude Code.
3. Read `references/codex.md` only when the active host is OpenAI Codex.
4. Read `references/recovery.md` only on blocked, partial, conflict, missing
   executable, wrong-worktree, or failed activation evidence.

## Resolve the target and executable

1. Resolve the exact target checkout. Prefer an explicit path from the user.
   Otherwise use the current working directory only when
   `git rev-parse --show-toplevel` identifies one unambiguous worktree. Use that
   checkout top level, not the Git common directory. Stop on a non-Git folder.
   Never run `git init`.
2. Resolve the CLI once in this bounded order:
   - an exact executable path explicitly supplied by the user;
   - a non-empty `VIBEHUB_BIN` already present in the host environment;
   - the existing `vibehub` found by `command -v vibehub`;
   - the plugin-local CLI entrypoint already present beneath
     `${CLAUDE_PLUGIN_ROOT}/packages/cli/dist/main.js`, invoked with `node`.
3. Stop if none exists. Never download, install, build, search unrelated
   directories, or improvise a replacement executable.
4. Quote the exact checkout and executable in shell commands. Do not silently
   switch targets after inspection.

## Workflow

The fixed sequence is `setup inspect --json`, `setup apply --json`, then
`setup status --json`, always with `--repo <exact-checkout>`. For every command,
parse stdout as JSON on exit 0 or 1. An exit code never replaces the
`ProjectActivationResultV1` evidence.

1. Run `<resolved-cli> setup inspect --repo <exact-checkout> --json` before any
   apply. Parse its JSON even when it exits 1. The raw
   `ProjectActivationResultV1` is the evidence: inspect `outcome`,
   `instructions`, `runtime`, `activation`, and `errors`; do not infer success
   from prose or exit status alone.
2. If inspection is blocked or partial, stop and load recovery guidance. Never
   edit managed markers, write the database, alter hooks, or repair files by
   hand.
3. Before applying, explain the two owned targets, `AGENTS.md` and `CLAUDE.md`,
   and that only the VibeHub managed block may change. State any planned
   append/upgrade and obtain approval when the host requires it.
4. Run `<resolved-cli> setup apply --repo <exact-checkout> --json`. Parse stdout
   as JSON on exit 0 or 1 and preserve the complete result. Continue to status
   only when `ok:true`, `outcome` is `applied` or `unchanged`, and `errors` is
   empty. On `blocked`, `partial`, `unhealthy`, any non-empty errors, or any
   unexpected outcome, stop immediately, load recovery guidance, and present
   the full apply result plus every retained backup path. After a
   user-approved repair, begin again with a fresh inspect; never run status to
   conceal a failed or partial apply. Do not call a successful apply Activated.
5. Run `<resolved-cli> setup status --repo <exact-checkout> --json`. Parse stdout
   as JSON on exit 0 or 1. A repeated
   current setup should be idempotent and quiet: if apply reports `unchanged`,
   do not manufacture an effect or celebratory event.
6. After a changeful apply, or when Connected lacks a host handshake, follow
   the active host's reference procedure. For Claude Code, restart the host
   in the exact checkout, re-run status, and let only its deterministic
   proof establish Connected. For OpenAI Codex, this release has no
   validated lifecycle-hook signal: report the waiting status honestly and
   never manufacture a handshake.
7. Once Connected, classify the project semantically by inspecting tracked,
   substantive implementation files and repository history:
   - unborn history, documentation-only content, or scaffold-only tracked
     files means fresh; invite normal brainstorming, documentation, or
     context-building work;
   - meaningful tracked implementation plus established history means
     existing-code; explicitly recommend `$vibehub-distill`, while allowing
     the user to skip it;
   - mixed or uncertain signals remain ambiguous; list the observed file and
     history signals and ask the user which path fits.
   This judgment stays in the skill. Never encode it in setup/core, infer it
   from file count alone, or hide distillation inside setup.
8. Obtain real context value through a meaningful `$vibehub-query` or
   `$vibehub-ingest`, then re-run setup status. An empty query, failed operation,
   skipped ingest, or invented knowledge write does not prove Activated.
9. Render the outcome with these exact portable labels:

   ```text
   Activity: Setup
   Trigger: <why setup ran now>
   Effects: <files/runtime/context actually changed, or none>
   Result: <applied|unchanged|waiting|blocked|partial plus proof states>
   Next: <one required or optional user action>
   ```

   Keep raw `ProjectActivationResultV1` available as evidence. Do not invent a
   separate workflow wire receipt or claim richer TUI components.

## External-send boundary

Package tests, local fixtures, and synthetic hook events are not real Claude
host proof. A real dogfood run requires explicit user approval and the exact
target path before setup writes or host-triggered context leaves this
development checkout. The same approval boundary applies to a real Codex
host run.

## Guardrails

- Never overwrite user-authored instruction content.
- Never delete retained backups or bypass a typed conflict.
- Never claim Installed, Connected, or Activated without the corresponding
  deterministic proof state.
- Never manufacture a query result, ingest write, host handshake, or successful
  receipt to complete onboarding.
