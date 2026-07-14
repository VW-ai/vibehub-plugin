/**
 * Hook ingestion — the logic behind `vibehub hook <event>` (the system's
 * heart, decision-project-025): one short-lived pass per hook fire —
 * write the event → claim the injection queue → return. Zero LLM, zero
 * daemon (decision-project-016: 采集永不依赖 app 活着).
 *
 * Robustness contract: this function may throw (no repo, bad payload) —
 * the CLI catches EVERYTHING and exits 0, because a hook must never break
 * the user's session.
 *
 * Task association (decision-project-024: branch is the join key;
 * decision-project-017: terminal sessions auto-captured as 未命名的事):
 * events land on one opaque repository-qualified task, created on first
 * sight with the branch name as its only honest title.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import type {
  StateTransitionEvent,
  TimelineEvent,
} from "./contract/panel-types.js";
import type { TaskState } from "./contract/map-types.js";
import {
  addFootprint,
  appendEvent,
  claimPendingInjections,
  hasEvent,
  readTask,
  readTaskForBranch,
  taskIdForBranch,
  upsertSession,
  upsertTask,
  type ClaimedInjection,
} from "./activity-store.js";
import { classifyUserPrompt } from "./milestone.js";
import type { Db } from "./db.js";
import { GitFacade } from "./git-facade.js";
import { nextState, type HookEventName } from "./state-machine.js";
import { getRepoByRoot, upsertRepo } from "./team-store.js";
import { claimOffScopeReminder } from "./scope-registry.js";

/** The fields Claude Code sends every hook (plus event-specific extras). */
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
  /** Claude Code prompt UUID (absent until first user input / old versions). */
  prompt_id?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Notification
  message?: string;
  // SessionEnd
  reason?: string;
  // Stop / failure hooks (documented public fields)
  last_assistant_message?: string;
  error?: string;
  error_details?: string;
  [key: string]: unknown;
}

export interface HookIngestResult {
  taskId: string;
  eventTypesWritten: string[];
  stateBefore: TaskState | null;
  stateAfter: TaskState;
  /** Hook-protocol stdout object (injection delivery), if any. */
  output?: {
    hookSpecificOutput?: {
      hookEventName: string;
      additionalContext: string;
    };
    decision?: "block";
    reason?: string;
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Tail window for transcript scans. Long sessions grow transcripts to tens
 * of MB and Stop fires often — reading the whole file each time is the
 * cost; the final assistant message lives at the end. 256 KiB comfortably
 * holds any single turn (tunable if a real transcript ever proves
 * otherwise); a full-file fallback covers the pathological case.
 */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function readTail(filePath: string, bytes: number): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Last assistant text from a Claude Code JSONL transcript; null if none. */
export function lastAssistantText(transcriptPath: string): string | null {
  const tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (tail === null) return null;
  return (
    scanForLastAssistant(tail) ??
    // no assistant entry in the tail window — fall back to the full file
    // (a partial first line in the tail parses as garbage and is skipped)
    scanForLastAssistant(readTail(transcriptPath, Number.MAX_SAFE_INTEGER) ?? "")
  );
}

function scanForLastAssistant(raw: string): string | null {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string };
      };
      if (entry.type !== "assistant" || entry.message?.role !== "assistant") continue;
      const content = entry.message.content;
      if (typeof content === "string") return content || null;
      const text = (content ?? [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    } catch {
      // non-JSON line — keep scanning
    }
  }
  return null;
}

export function ingestHookEvent(
  db: Db,
  hook: HookEventName,
  payload: HookPayload,
  opts: { now?: () => Date } = {},
): HookIngestResult {
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  // One spawn for the session facts (hot path: this runs on every tool
  // use). Branch/toplevel come from the SESSION's cwd (a worktree has its
  // own HEAD); repoRoot is the shared domain (decision-github-004).
  const ctx = GitFacade.sessionContextAt(payload.cwd);
  // Slug/default-branch are stable repo facts — spawn for them only the
  // first time this repo is ever seen.
  let repo = getRepoByRoot(db, ctx.repoRoot);
  if (!repo) {
    const git = new GitFacade(payload.cwd);
    repo = upsertRepo(
      db,
      git.repoRoot,
      git.remoteSlug(),
      git.defaultBranchOr("main"),
      nowIso,
    );
  }

  const branch = ctx.branch ?? "detached";
  const sessionToplevel = ctx.toplevel;
  const existing = readTaskForBranch(db, repo.id, branch);
  const taskId = existing?.id ?? taskIdForBranch(repo.id, branch);
  const stateBefore = existing?.state ?? null;
  const deliveryCapable =
    hook === "UserPromptSubmit" ||
    hook === "PostToolUse" ||
    hook === "Stop" ||
    hook === "SessionStart";
  const claimed = deliveryCapable
    ? claimPendingInjections(db, taskId, nowIso)
    : [];
  // Claiming an injection proves queue ownership, not that the runtime has
  // resumed. Preserve the Stop-observed waiting state until a later hook
  // supplies independent runtime evidence.
  const stateAfter = nextState(existing?.state ?? "queued", hook);

  upsertTask(db, {
    id: taskId,
    repoId: repo.id,
    title: existing?.title ?? branch,
    state: stateAfter,
    signalTier: "hooks",
    branch,
    worktreePath:
      sessionToplevel !== ctx.repoRoot ? sessionToplevel : null,
    prNumber: existing?.prNumber ?? null,
    prState: existing?.prState ?? null,
    stateSince: stateAfter === stateBefore ? existing!.stateSince : nowIso,
    lastEventAt: nowIso,
    statusDetail: statusDetailFor(hook, payload, existing?.statusDetail ?? null),
    createdAt: existing?.createdAt ?? nowIso,
    startHeadSha: existing?.startHeadSha ?? GitFacade.headShaAt(sessionToplevel),
  });

  upsertSession(db, {
    id: payload.session_id,
    repoId: repo.id,
    taskId,
    agent: "Claude Code",
    transcriptPath: payload.transcript_path ?? null,
    startedAt: existingSessionStart(db, payload.session_id) ?? nowIso,
    endedAt: hook === "SessionEnd" ? nowIso : null,
    endReason: hook === "SessionEnd" ? mapEndReason(payload.reason) : null,
  });

  const written: string[] = [];
  const emit = (e: TimelineEvent): void => {
    appendEvent(db, repo.id, taskId, payload.session_id, e);
    written.push(e.type);
  };
  const eid = (): string => crypto.randomUUID();
  const conditionalContext: string[] = [];

  switch (hook) {
    case "UserPromptSubmit": {
      if (payload.prompt) {
        const hasLaunch = hasEvent(db, taskId, "launch");
        const promptId = payload.prompt_id;
        emit(
          hasLaunch
            ? {
                id: eid(),
                at: nowIso,
                type: "user_injection",
                mode: "inject",
                text: payload.prompt,
                // mechanical milestone tier (decision-workbench-001); the
                // launch prompt below needs none — founding instructions are
                // always milestone (023)
                classification: classifyUserPrompt(payload.prompt),
                ...(promptId ? { promptId } : {}),
              }
            : {
                id: eid(),
                at: nowIso,
                type: "launch",
                prompt: payload.prompt,
                ...(promptId ? { promptId } : {}),
              },
        );
      }
      break;
    }
    case "PostToolUse": {
      const file = payload.tool_input?.["file_path"];
      if (typeof file === "string" && payload.tool_name) {
        const action = EDIT_TOOLS.has(payload.tool_name)
          ? "edit"
          : payload.tool_name === "Read"
            ? "read"
            : null;
        if (action) {
          const relativeFile = repoRelative(file, sessionToplevel);
          addFootprint(db, repo.id, {
            taskId,
            sessionId: payload.session_id,
            path: relativeFile,
            action,
            at: nowIso,
          });
          if (
            action === "edit" &&
            claimOffScopeReminder(db, taskId, relativeFile, nowIso)
          ) {
            conditionalContext.push(formatOffScopeReminder(relativeFile));
          }
        }
      }
      break;
    }
    case "Notification": {
      if (payload.message) {
        emit({
          id: eid(),
          at: nowIso,
          type: "question",
          text: payload.message,
          transitionTo: "waiting",
        });
      }
      break;
    }
    case "Stop": {
      // The agent's own final turn text, verbatim from the transcript —
      // contract SelfReportEvent source. Nothing synthesized.
      const text = payload.last_assistant_message ?? (
        payload.transcript_path ? lastAssistantText(payload.transcript_path) : null
      );
      if (text) emit({ id: eid(), at: nowIso, type: "self_report", text });
      break;
    }
    case "SessionStart":
    case "SessionEnd":
    case "SubagentStart":
    case "SubagentStop":
    case "PostToolUseFailure":
    case "StopFailure":
      break;
  }

  if (stateBefore !== null && stateBefore !== stateAfter) {
    const transition: StateTransitionEvent = {
      id: eid(),
      at: nowIso,
      type: "state_transition",
      from: stateBefore,
      to: stateAfter,
      ...(hook === "Notification" && payload.message
        ? { cause: payload.message }
        : {}),
    };
    emit(transition);
  }

  // 注入队列回查 (decision-project-018) — deliver pending notes at every
  // hook boundary that can deliver guidance. Stop is the fast lane: its
  // official decision:block + reason asks the runtime to continue, while
  // task state remains waiting until a subsequent hook proves it resumed.
  // SessionStart catches notes queued while the session was away.
  // Claiming (claimed_at) is the single-consumer ownership receipt; the
  // context was emitted to Claude Code in this process, but that alone is
  // not evidence that the runtime resumed. There is no daemon to time out a
  // pending note — "still undelivered" is a read-side derivation
  // (pendingInjections + age), surfaced by the UI, never a stored state.
  let output: HookIngestResult["output"];
  if (deliveryCapable) {
    if (claimed.length > 0) {
      for (const c of claimed) {
        emit({
          id: eid(),
          at: nowIso,
          type: "user_injection",
          mode: c.mode,
          text: c.text,
        });
      }
      if (hook === "Stop") {
        output = { decision: "block", reason: formatDelivery(claimed) };
      } else {
        conditionalContext.push(formatDelivery(claimed));
      }
    }
  }

  if (hook === "SessionStart") conditionalContext.unshift(SESSION_PROTOCOL);
  if (!output && conditionalContext.length > 0) {
    output = {
      hookSpecificOutput: {
        hookEventName: hook,
        additionalContext: conditionalContext.join("\n\n"),
      },
    };
  }

  return { taskId, eventTypesWritten: written, stateBefore, stateAfter, output };
}

const SESSION_PROTOCOL = `[Vibehub] This repo runs Vibehub — your team's shared context layer. Protocol:
1. Before your first edit, call register_scope with what you'll touch and one line on what you're doing.
2. Before working in code you haven't touched this session, use the vibehub-query skill; decisions and constraints may bind it.
3. When a design decision is made, use the vibehub-ingest skill to capture it now; don't batch it for later.
4. If your direction changes, call self_report with one line.
Call get_manual only when you need the full picture. Skipping this protocol hides your work from your team.`;

function formatOffScopeReminder(file: string): string {
  return (
    `[Vibehub] Your last edit (${file}) is outside your declared write scope. ` +
    "If your plan changed, call self_report with one line and register_scope the new area. " +
    "If this is a quick touch-up, continue; you won't be reminded again for this scope."
  );
}

/**
 * Delivery wrapper (decision-project-018 双模). Approved B3 wording; any
 * later change is a product change and must leave a spec trace.
 * One batch = all pending notes FIFO; one pause makes the whole batch a
 * pause (the stricter semantic wins — the agent can't half-stop).
 */
function formatDelivery(claimed: ClaimedInjection[]): string {
  if (claimed.length === 1 && claimed[0]!.context && claimed[0]!.mode === "inject") {
    const note = claimed[0]!;
    return (
      `[Vibehub] Message from your user while viewing ${note.context}:\n` +
      `${note.text}\n` +
      "Treat this as guidance for the current task; do not restart or re-plan work that is already settled."
    );
  }
  const lines = claimed.map((c) => `- ${c.text}`).join("\n");
  if (claimed.some((c) => c.mode === "pause")) {
    return (
      "[Vibehub] PAUSE from your user:\n" +
      lines +
      "\nStop what you're doing — no further tool calls. Reply to this, then wait for your user before continuing."
    );
  }
  return "[Vibehub] Message(s) from your user:\n" + lines;
}

function existingSessionStart(db: Db, sessionId: string): string | null {
  const r = db
    .prepare(`SELECT started_at AS s FROM sessions WHERE id = ?`)
    .get(sessionId) as { s: string } | undefined;
  return r?.s ?? null;
}

function mapEndReason(
  reason: string | undefined,
): "context_limit" | "user_ended" | "completed" {
  if (reason === "auto_compact" || reason === "context_limit") return "context_limit";
  if (reason === "clear" || reason === "logout" || reason === "exit") return "user_ended";
  return "completed";
}

function statusDetailFor(
  hook: HookEventName,
  payload: HookPayload,
  previous: string | null,
): string | null {
  if (hook === "Notification" && payload.message) return payload.message;
  if ((hook === "PostToolUseFailure" || hook === "StopFailure") && payload.error) {
    return payload.error_details ? `${payload.error}: ${payload.error_details}` : payload.error;
  }
  return previous;
}

function repoRelative(file: string, repoRoot: string): string {
  return file.startsWith(repoRoot + "/") ? file.slice(repoRoot.length + 1) : file;
}
