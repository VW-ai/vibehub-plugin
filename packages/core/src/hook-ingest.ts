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
 * events land on task `branch:<current-branch>`, created on first sight
 * with the branch name as its only honest title.
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
  readTask,
  readTimeline,
  upsertSession,
  upsertTask,
} from "./activity-store.js";
import type { Db } from "./db.js";
import { GitFacade } from "./git-facade.js";
import { nextState, type HookEventName } from "./state-machine.js";
import { upsertRepo } from "./team-store.js";

/** The fields Claude Code sends every hook (plus event-specific extras). */
export interface HookPayload {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name?: string;
  // UserPromptSubmit
  prompt?: string;
  // PostToolUse
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Notification
  message?: string;
  // SessionEnd
  reason?: string;
  [key: string]: unknown;
}

export interface HookIngestResult {
  taskId: string;
  eventTypesWritten: string[];
  stateBefore: TaskState | null;
  stateAfter: TaskState;
  /** Hook-protocol stdout object (injection delivery), if any. */
  output?: {
    hookSpecificOutput: {
      hookEventName: string;
      additionalContext: string;
    };
  };
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Last assistant text from a Claude Code JSONL transcript; null if none. */
export function lastAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
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
  const git = new GitFacade(payload.cwd);
  const repo = upsertRepo(
    db,
    git.repoRoot,
    git.remoteSlug(),
    git.defaultBranchOr("main"),
    nowIso,
  );

  // Branch/toplevel come from the SESSION's cwd (a worktree has its own
  // HEAD); the repo row above is the shared domain (decision-github-004).
  const branch = GitFacade.currentBranchAt(payload.cwd) ?? "detached";
  const sessionToplevel = GitFacade.toplevelAt(payload.cwd);
  const taskId = `branch:${branch}`;
  const existing = readTask(db, taskId);
  const stateBefore = existing?.state ?? null;
  const stateAfter = nextState(existing?.state ?? "queued", hook);

  upsertTask(db, {
    id: taskId,
    repoId: repo.id,
    title: existing?.title ?? branch,
    state: stateAfter,
    signalTier: "hooks",
    branch,
    worktreePath:
      sessionToplevel && sessionToplevel !== git.repoRoot ? sessionToplevel : null,
    prNumber: existing?.prNumber ?? null,
    prState: existing?.prState ?? null,
    stateSince: stateAfter === stateBefore ? existing!.stateSince : nowIso,
    lastEventAt: nowIso,
    statusDetail:
      hook === "Notification" && payload.message
        ? payload.message
        : (existing?.statusDetail ?? null),
    createdAt: existing?.createdAt ?? nowIso,
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

  switch (hook) {
    case "UserPromptSubmit": {
      if (payload.prompt) {
        const hasLaunch = readTimeline(db, taskId).some((e) => e.type === "launch");
        emit(
          hasLaunch
            ? { id: eid(), at: nowIso, type: "user_injection", mode: "inject", text: payload.prompt }
            : { id: eid(), at: nowIso, type: "launch", prompt: payload.prompt },
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
          addFootprint(db, repo.id, {
            taskId,
            sessionId: payload.session_id,
            path: repoRelative(file, sessionToplevel ?? git.repoRoot),
            action,
            at: nowIso,
          });
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
      const text = payload.transcript_path
        ? lastAssistantText(payload.transcript_path)
        : null;
      if (text) emit({ id: eid(), at: nowIso, type: "self_report", text });
      break;
    }
    case "SessionStart":
    case "SessionEnd":
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

  // 注入队列回查 (decision-project-018) — deliver pending notes at the
  // hook boundaries that accept additionalContext.
  let output: HookIngestResult["output"];
  if (hook === "UserPromptSubmit" || hook === "PostToolUse") {
    const claimed = claimPendingInjections(db, taskId, nowIso);
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
      output = {
        hookSpecificOutput: {
          hookEventName: hook,
          additionalContext:
            "[Vibehub] Message(s) from your user:\n" +
            claimed.map((c) => `- ${c.text}`).join("\n"),
        },
      };
    }
  }

  return { taskId, eventTypesWritten: written, stateBefore, stateAfter, output };
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

function repoRelative(file: string, repoRoot: string): string {
  return file.startsWith(repoRoot + "/") ? file.slice(repoRoot.length + 1) : file;
}
