import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import {
  ingestHookEvent,
  lastAssistantText,
  type HookPayload,
} from "../src/hook-ingest.js";
import { nextState } from "../src/state-machine.js";
import {
  enqueueInjection,
  listTasks,
  pendingInjections,
  readFootprints,
  readTask,
  readTimeline,
  sessionIdentity,
  taskIdForBranch,
} from "../src/activity-store.js";
import { readTaskPanelModel } from "../src/live-read-models.js";
import { getRepoByRoot } from "../src/team-store.js";
import { replaceScopePatterns } from "../src/scope-registry.js";
import { setSetting } from "../src/graph-store.js";
import {
  CHECKPOINT_CADENCE_SETTING_KEY,
} from "../src/knowledge-checkpoint.js";
import { KnowledgeService, type DraftBatchInput, type MutationContext } from "../src/knowledge-service.js";
import { OperationDispatcher } from "../src/operation-dispatcher.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const T = (m: number): Date => new Date(`2026-07-12T10:${String(m).padStart(2, "0")}:00.000Z`);

describe("nextState (021: five states, no daemon)", () => {
  it("activity flows to running", () => {
    expect(nextState("queued", "SessionStart")).toBe("running");
    expect(nextState("waiting", "UserPromptSubmit")).toBe("running");
    expect(nextState("running", "PostToolUse")).toBe("running");
  });
  it("stop-shaped events flow to waiting", () => {
    expect(nextState("running", "Notification")).toBe("waiting");
    expect(nextState("running", "Stop")).toBe("waiting");
  });
  it("session end flows to done", () => {
    expect(nextState("running", "SessionEnd")).toBe("done");
  });
});

describe("ingestHookEvent on a scratch repo", () => {
  let repo: ScratchRepo;
  let dir: string;
  let db: Db;
  let taskBranch: string;

  const payload = (extra: Partial<HookPayload> = {}): HookPayload => ({
    session_id: "sess-1",
    cwd: repo.work,
    ...extra,
  });

  beforeEach(() => {
    repo = makeScratchRepo();
    git(repo.work, "checkout", "-b", "vibehub/fix-login");
    taskBranch = taskIdForBranch(1, "vibehub/fix-login");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-hook-"));
    db = openDb(path.join(dir, "t.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  });

  it("auto-captures the branch as an unnamed 事 (017/024) and runs the state machine", () => {
    const r = ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    expect(r.taskId).toBe(taskBranch);
    expect(r.stateBefore).toBeNull();
    expect(r.stateAfter).toBe("running");

    const task = readTask(db, taskBranch)!;
    expect(task.title).toBe("vibehub/fix-login"); // branch = the only honest title
    expect(task.signalTier).toBe("hooks");
    expect(getRepoByRoot(db, repo.work)).not.toBeNull();
    expect(r.output?.hookSpecificOutput?.additionalContext).toContain(
      "use the vibehub-query skill",
    );
  });

  it("reminds once when an edit leaves the current raw write scope", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    replaceScopePatterns(db, repoId, taskBranch, "auth", [
      { mode: "write", glob: "src/auth/**" },
    ]);

    const outside = payload({
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo.work, "src/billing.ts") },
    });
    const first = ingestHookEvent(db, "PostToolUse", outside, { now: () => T(1) });
    expect(first.output?.hookSpecificOutput?.additionalContext).toContain(
      "src/billing.ts) is outside your declared write scope",
    );
    const second = ingestHookEvent(db, "PostToolUse", outside, { now: () => T(2) });
    expect(second.output).toBeUndefined();
  });

  it("first prompt = launch, later prompts = user_injection (contract LaunchEvent)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "Fix the login retry." }), { now: () => T(1) });
    ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "Also add a test." }), { now: () => T(2) });

    const tl = readTimeline(db, taskBranch);
    expect(tl.filter((e) => e.type === "launch")).toHaveLength(1);
    expect(tl[0]).toMatchObject({ type: "launch", prompt: "Fix the login retry." });
    expect(tl.filter((e) => e.type === "user_injection")).toHaveLength(1);
  });

  it("PostToolUse writes repo-relative footprints, edit vs read", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    ingestHookEvent(db, "PostToolUse", payload({
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo.work, "src/auth/login.ts") },
    }), { now: () => T(1) });
    ingestHookEvent(db, "PostToolUse", payload({
      tool_name: "Read",
      tool_input: { file_path: path.join(repo.work, "src/shared.ts") },
    }), { now: () => T(2) });
    ingestHookEvent(db, "PostToolUse", payload({
      tool_name: "Bash",
      tool_input: { command: "ls" },
    }), { now: () => T(3) });

    expect(readFootprints(db, taskBranch)).toEqual([
      { taskId: taskBranch, sessionId: "sess-1", path: "src/auth/login.ts", action: "edit", at: T(1).toISOString() },
      { taskId: taskBranch, sessionId: "sess-1", path: "src/shared.ts", action: "read", at: T(2).toISOString() },
    ]);
  });

  it("Notification → question event + waiting with verbatim cause", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const r = ingestHookEvent(db, "Notification", payload({ message: "Which retry pattern?" }), { now: () => T(1) });
    expect(r.stateAfter).toBe("waiting");

    const task = readTask(db, taskBranch)!;
    expect(task.statusDetail).toBe("Which retry pattern?");
    expect(task.stateSince).toBe(T(1).toISOString());

    const tl = readTimeline(db, taskBranch);
    expect(tl.find((e) => e.type === "question")).toMatchObject({
      text: "Which retry pattern?",
      transitionTo: "waiting",
    });
    expect(tl.find((e) => e.type === "state_transition")).toMatchObject({
      from: "running",
      to: "waiting",
      cause: "Which retry pattern?",
    });
  });

  it("Stop harvests the agent's own last text as self_report (verbatim)", () => {
    const transcript = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done. Retry guard added, 3 tests green." }],
          },
        }),
        "",
      ].join("\n"),
    );
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    ingestHookEvent(db, "Stop", payload({ transcript_path: transcript }), { now: () => T(1) });

    const tl = readTimeline(db, taskBranch);
    expect(tl.find((e) => e.type === "self_report")).toMatchObject({
      text: "Done. Retry guard added, 3 tests green.",
    });
    expect(readTask(db, taskBranch)!.state).toBe("waiting");
  });

  it("uses Stop's public last_assistant_message without reading the transcript", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    ingestHookEvent(db, "Stop", payload({ last_assistant_message: "Public field report." }), {
      now: () => T(1),
    });
    expect(readTimeline(db, taskBranch).find((e) => e.type === "self_report")).toMatchObject({
      text: "Public field report.",
    });
  });

  it("reads Stop transcript text before entering the immediate write transaction", () => {
    const transcript = path.join(dir, "stop.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: "Read outside the write lock." },
    }) + "\n");
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const originalOpen = fs.openSync;
    let observedTransaction = true;
    const open = ((...args: Parameters<typeof fs.openSync>) => {
      observedTransaction = db.inTransaction;
      return originalOpen(...args);
    }) as typeof fs.openSync;
    fs.openSync = open;
    try {
      ingestHookEvent(db, "Stop", payload({ transcript_path: transcript }), {
        now: () => T(1),
      });
    } finally {
      fs.openSync = originalOpen;
    }
    expect(observedTransaction).toBe(false);
    expect(readTimeline(db, taskBranch).find((e) => e.type === "self_report")).toMatchObject({
      text: "Read outside the write lock.",
    });
  });

  it("records failure detail without fabricating a state transition", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const result = ingestHookEvent(
      db,
      "StopFailure",
      payload({ error: "rate_limit", error_details: "429" }),
      { now: () => T(1) },
    );
    expect(result.stateAfter).toBe("running");
    expect(readTask(db, taskBranch)?.statusDetail).toBe("rate_limit: 429");
  });

  it("SessionEnd closes the session and the task goes done", () => {
    ingestHookEvent(db, "SessionStart", payload({ transcript_path: "/tmp/x.jsonl" }), { now: () => T(0) });
    ingestHookEvent(db, "SessionEnd", payload({ reason: "exit" }), { now: () => T(9) });

    expect(readTask(db, taskBranch)!.state).toBe("done");
    const identity = sessionIdentity(db, taskBranch, "sess-1")!;
    expect(identity.sessionOrdinal).toBe(1);
  });

  it("claims queued injections at the turn boundary and emits hook output (018)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "inject", "Skip the legacy path.", T(1).toISOString());

    const r = ingestHookEvent(db, "PostToolUse", payload({
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo.work, "src/a.ts") },
    }), { now: () => T(2) });

    expect(r.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "[Vibehub] Message(s) from your user:\n- Skip the legacy path.",
      },
    });
    // delivery is recorded in the timeline (介入必入史, 023)
    expect(readTimeline(db, taskBranch).find((e) => e.type === "user_injection")).toMatchObject({
      mode: "inject",
      text: "Skip the legacy path.",
    });
    // never double-delivered
    const r2 = ingestHookEvent(db, "PostToolUse", payload({
      tool_name: "Edit",
      tool_input: { file_path: path.join(repo.work, "src/a.ts") },
    }), { now: () => T(3) });
    expect(r2.output).toBeUndefined();
  });

  it("resolves relative tool paths from payload cwd before enforcing the session boundary", () => {
    const nested = path.join(repo.work, "src", "nested");
    fs.mkdirSync(nested, { recursive: true });
    ingestHookEvent(db, "SessionStart", payload({ cwd: nested }), { now: () => T(0) });

    ingestHookEvent(db, "PostToolUse", payload({
      cwd: nested,
      tool_name: "Edit",
      tool_input: { file_path: "local.ts" },
    }), { now: () => T(1) });
    ingestHookEvent(db, "PostToolUse", payload({
      cwd: nested,
      tool_name: "Read",
      tool_input: { file_path: "../shared.ts" },
    }), { now: () => T(2) });

    expect(readFootprints(db, taskBranch)).toMatchObject([
      { path: "src/nested/local.ts", action: "edit" },
      { path: "src/shared.ts", action: "read" },
    ]);
    expect(() => ingestHookEvent(db, "PostToolUse", payload({
      cwd: nested,
      tool_name: "Edit",
      tool_input: { file_path: "../../../outside.ts" },
    }), { now: () => T(3) })).toThrow(/repo-relative|outside/);
    expect(readFootprints(db, taskBranch)).toHaveLength(2);
  });

  it("rolls back claim and all hook writes after a deterministic post-claim DB failure", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    db.prepare(`UPDATE tasks SET state = 'waiting', state_since = ? WHERE id = ?`)
      .run(T(0).toISOString(), taskBranch);
    replaceScopePatterns(db, repoId, taskBranch, "auth", [
      { mode: "write", glob: "src/auth/**" },
    ]);
    enqueueInjection(
      db,
      repoId,
      taskBranch,
      "inject",
      "Preserve this message.",
      T(1).toISOString(),
    );
    db.exec(`CREATE TRIGGER fail_hook_delivery
      BEFORE INSERT ON events WHEN NEW.type = 'user_injection'
      BEGIN SELECT RAISE(FAIL, 'forced post-claim hook failure'); END`);

    expect(() =>
      ingestHookEvent(
        db,
        "PostToolUse",
        payload({
          session_id: "sess-failing",
          tool_name: "Edit",
          tool_input: { file_path: "src/outside-scope.ts" },
        }),
        { now: () => T(2) },
      ),
    ).toThrow(/forced post-claim hook failure/);
    // The waiting→running transition is inserted before delivery, so this
    // proves an already-successful event write was rolled back too.
    expect(readTimeline(db, taskBranch)).toEqual([]);
    expect(readFootprints(db, taskBranch)).toEqual([]);
    expect(readTask(db, taskBranch)?.lastEventAt).toBe(T(0).toISOString());
    expect(readTask(db, taskBranch)?.state).toBe("waiting");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'sess-failing'`).get())
      .toEqual({ n: 0 });
    expect(db.prepare(`SELECT reminded_at FROM scope_patterns WHERE task_id = ?`).all(taskBranch))
      .toEqual([{ reminded_at: null }]);
    expect(pendingInjections(db, taskBranch)).toMatchObject([
      { mode: "inject", text: "Preserve this message." },
    ]);

    db.exec(`DROP TRIGGER fail_hook_delivery`);
    const valid = ingestHookEvent(
      db,
      "PostToolUse",
      payload({
        session_id: "sess-failing",
        tool_name: "Edit",
        tool_input: { file_path: "src/outside-scope.ts" },
      }),
      { now: () => T(3) },
    );
    expect(valid.output?.hookSpecificOutput?.additionalContext).toContain(
      "Preserve this message.",
    );
    expect(
      readTimeline(db, taskBranch).filter((event) => event.type === "user_injection"),
    ).toHaveLength(1);
    expect(readFootprints(db, taskBranch)).toMatchObject([
      { sessionId: "sess-failing", path: "src/outside-scope.ts", action: "edit" },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id = 'sess-failing'`).get())
      .toEqual({ n: 1 });
    expect(db.prepare(`SELECT reminded_at FROM scope_patterns WHERE task_id = ?`).all(taskBranch))
      .toEqual([{ reminded_at: T(3).toISOString() }]);
    expect(pendingInjections(db, taskBranch)).toEqual([]);
  });

  it("carries the panel locus into the delivery wrapper", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(
      db,
      repoId,
      taskBranch,
      "inject",
      "Keep the public contract stable.",
      T(1).toISOString(),
      "Conflict card · packages/core/src/index.ts",
    );

    const r = ingestHookEvent(db, "PostToolUse", payload(), { now: () => T(2) });

    expect(r.output?.hookSpecificOutput?.additionalContext).toBe(
      "[Vibehub] Message from your user while viewing Conflict card · packages/core/src/index.ts:\n" +
        "Keep the public contract stable.\n" +
        "Treat this as guidance for the current task; do not restart or re-plan work that is already settled.",
    );
  });

  it("Stop delivers pending injections — the wake-the-agent fast lane", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "inject", "Also update the docs.", T(1).toISOString());

    const r = ingestHookEvent(db, "Stop", payload(), { now: () => T(2) });
    expect(r.output).toEqual({
      decision: "block",
      reason: "[Vibehub] Message(s) from your user:\n- Also update the docs.",
    });
    expect(pendingInjections(db, taskBranch)).toEqual([]);
    expect(readTask(db, taskBranch)?.state).toBe("waiting");
    expect(r.stateAfter).toBe("waiting");
  });

  it("SessionStart delivers notes queued while the session was away", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    ingestHookEvent(db, "SessionEnd", payload({ reason: "exit" }), { now: () => T(1) });
    enqueueInjection(db, repoId, taskBranch, "inject", "When you're back: rebase first.", T(2).toISOString());

    const r = ingestHookEvent(db, "SessionStart", payload({ session_id: "sess-2" }), { now: () => T(3) });
    expect(r.output?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(r.output?.hookSpecificOutput?.additionalContext).toContain("rebase first");
  });

  it("one pause in the batch makes the WHOLE batch a pause (stricter wins)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "inject", "First note.", T(1).toISOString());
    enqueueInjection(db, repoId, taskBranch, "pause", "Stop — let's talk.", T(2).toISOString());

    const r = ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "继续" }), { now: () => T(3) });
    const ctx = r.output!.hookSpecificOutput!.additionalContext;
    expect(ctx).toContain("[Vibehub] PAUSE from your user:");
    // FIFO order preserved inside the batch
    expect(ctx.indexOf("First note.")).toBeLessThan(ctx.indexOf("Stop — let's talk."));
    expect(ctx).toContain("no further tool calls");
  });

  it("pendingInjections is the read-side delivery-timeout view (no stored state)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "pause", "Anyone there?", T(1).toISOString());

    // still pending — no delivery-capable hook has fired since enqueue
    expect(pendingInjections(db, taskBranch)).toMatchObject([
      { mode: "pause", text: "Anyone there?", createdAt: T(1).toISOString() },
    ]);
    // Notification cannot carry additionalContext → must NOT claim
    ingestHookEvent(db, "Notification", payload({ message: "?" }), { now: () => T(2) });
    expect(pendingInjections(db, taskBranch)).toHaveLength(1);

    ingestHookEvent(db, "Stop", payload(), { now: () => T(3) });
    expect(pendingInjections(db, taskBranch)).toEqual([]);
  });

  it("terminal-typed prompts carry prompt_id and a mechanical milestone tier (workbench-001)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "Fix the login retry.", prompt_id: "p-1" }), { now: () => T(1) });
    ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "继续", prompt_id: "p-2" }), { now: () => T(2) });
    ingestHookEvent(db, "UserPromptSubmit", payload({ prompt: "换个方向:先把注入队列的送达确认做完,再回来处理里程碑分类的模糊区,顺序不要反。", prompt_id: "p-3" }), { now: () => T(3) });

    const tl = readTimeline(db, taskBranch);
    expect(tl.find((e) => e.type === "launch")).toMatchObject({ promptId: "p-1" });
    const injections = tl.filter((e) => e.type === "user_injection");
    expect(injections[0]).toMatchObject({ promptId: "p-2", classification: "default" });
    expect(injections[1]).toMatchObject({ promptId: "p-3", classification: "milestone" });
  });

  it("deck-queued injections carry NO classification (deliberate intervention = always milestone)", () => {
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "inject", "ok", T(1).toISOString());
    ingestHookEvent(db, "Stop", payload(), { now: () => T(2) });

    const e = readTimeline(db, taskBranch).find((x) => x.type === "user_injection")!;
    expect(e).not.toHaveProperty("classification");
  });

  it("a session in a WORKTREE lands on the same repo domain (github-004)", () => {
    const wt = path.join(repo.root, "wt");
    git(repo.work, "worktree", "add", "-b", "vibehub/wt-task", wt);
    ingestHookEvent(db, "SessionStart", payload({ cwd: wt, session_id: "sess-wt" }), { now: () => T(0) });

    const task = readTask(db, taskIdForBranch(1, "vibehub/wt-task"))!;
    expect(task.worktreePath).toBe(wt);
    // one repo domain: the worktree session's repo row is the MAIN root
    expect(getRepoByRoot(db, repo.work)).not.toBeNull();
  });
});

describe("ingestHookEvent repository ownership", () => {
  it("keeps identical branch names isolated across repositories in one SQLite database", () => {
    const repoA = makeScratchRepo();
    const repoB = makeScratchRepo();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-hook-repos-"));
    const db = openDb(path.join(dir, "t.db"));
    try {
      const startA = ingestHookEvent(db, "SessionStart", {
        session_id: "session-a",
        cwd: repoA.work,
      }, { now: () => T(0) });
      const ownerA = getRepoByRoot(db, repoA.work)!;
      enqueueInjection(db, ownerA.id, startA.taskId, "inject", "repo-a-only", T(0).toISOString());
      ingestHookEvent(db, "PostToolUse", {
        session_id: "session-a",
        cwd: repoA.work,
        tool_name: "Edit",
        tool_input: { file_path: path.join(repoA.work, "src/a.ts") },
      }, { now: () => T(1) });
      const startB = ingestHookEvent(db, "SessionStart", {
        session_id: "session-b",
        cwd: repoB.work,
      }, { now: () => T(2) });
      const ownerB = getRepoByRoot(db, repoB.work)!;
      enqueueInjection(db, ownerB.id, startB.taskId, "inject", "repo-b-only", T(2).toISOString());
      ingestHookEvent(db, "PostToolUse", {
        session_id: "session-b",
        cwd: repoB.work,
        tool_name: "Edit",
        tool_input: { file_path: path.join(repoB.work, "src/b.ts") },
      }, { now: () => T(3) });

      expect(startA.taskId).not.toBe(startB.taskId);
      expect(listTasks(db, ownerA.id)).toMatchObject([
        { id: startA.taskId, repoId: ownerA.id, branch: "main" },
      ]);
      expect(listTasks(db, ownerB.id)).toMatchObject([
        { id: startB.taskId, repoId: ownerB.id, branch: "main" },
      ]);
      expect(sessionIdentity(db, startA.taskId, "session-a")).not.toBeNull();
      expect(sessionIdentity(db, startA.taskId, "session-b")).toBeNull();
      expect(sessionIdentity(db, startB.taskId, "session-b")).not.toBeNull();
      expect(readTimeline(db, startA.taskId)).toMatchObject([{ text: "repo-a-only" }]);
      expect(readTimeline(db, startB.taskId)).toMatchObject([{ text: "repo-b-only" }]);
      expect(readFootprints(db, startA.taskId).map((row) => row.path)).toEqual(["src/a.ts"]);
      expect(readFootprints(db, startB.taskId).map((row) => row.path)).toEqual(["src/b.ts"]);
      expect(readTaskPanelModel(db, ownerA.id, repoA.work, startA.taskId, T(4).toISOString())).not.toBeNull();
      expect(readTaskPanelModel(db, ownerB.id, repoB.work, startA.taskId, T(4).toISOString())).toBeNull();
      expect(readTaskPanelModel(db, ownerB.id, repoB.work, startB.taskId, T(4).toISOString())).not.toBeNull();
      expect(readTaskPanelModel(db, ownerA.id, repoA.work, startB.taskId, T(4).toISOString())).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      repoA.cleanup();
      repoB.cleanup();
    }
  });
});

describe("knowledge checkpoint cadence (intent-workbench-003)", () => {
  let repo: ScratchRepo;
  let dir: string;
  let dbPath: string;
  let db: Db;
  let taskBranch: string;

  const payload = (extra: Partial<HookPayload> = {}): HookPayload => ({
    session_id: "sess-1",
    cwd: repo.work,
    ...extra,
  });
  const prompt = (n: number, extra: Partial<HookPayload> = {}) =>
    ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ prompt: `turn ${n}`, prompt_id: `p-${n}`, ...extra }),
      { now: () => T(n) },
    );
  const cadenceRow = (taskId: string) =>
    db.prepare(
      `SELECT counted_turns AS countedTurns, last_write_turn AS lastWriteTurn,
              last_reminder_turn AS lastReminderTurn, provenance_high_water AS provenanceHighWater
       FROM task_prompt_cadence WHERE task_id = ?`,
    ).get(taskId) as {
      countedTurns: number;
      lastWriteTurn: number;
      lastReminderTurn: number;
      provenanceHighWater: number;
    } | undefined;
  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const draftBatch = (key: string, specId: string): DraftBatchInput => ({
    idempotencyKey: key,
    specs: [{
      id: specId,
      type: "decision",
      summary: "Use exponential backoff for login retries",
      evidence: [{ sourceType: "chat", sourceRef: "turn:capture", exactQuote: "backoff decided" }],
    }],
  });
  const mutationCtx = (requestId: string, minute: number, taskId?: string): MutationContext => ({
    actor: "agent",
    ...(taskId ? { taskId } : {}),
    requestId,
    now: T(minute).toISOString(),
  });

  beforeEach(() => {
    repo = makeScratchRepo();
    git(repo.work, "checkout", "-b", "vibehub/fix-login");
    taskBranch = taskIdForBranch(1, "vibehub/fix-login");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-checkpoint-"));
    dbPath = path.join(dir, "t.db");
    db = openDb(dbPath);
    setSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, "3");
    ingestHookEvent(db, "SessionStart", payload(), { now: () => T(0) });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  });

  it("stays silent below the threshold and reports counted facts", () => {
    const first = prompt(1);
    const second = prompt(2);
    expect(first.checkpoint).toEqual({
      status: "counted", countedTurns: 1, turnsSinceLastWrite: 1, threshold: 3,
    });
    expect(second.checkpoint).toEqual({
      status: "counted", countedTurns: 2, turnsSinceLastWrite: 2, threshold: 3,
    });
    expect(first.output).toBeUndefined();
    expect(second.output).toBeUndefined();
  });

  it("fires at the threshold and re-arms every threshold turns", () => {
    prompt(1);
    prompt(2);
    const fired = prompt(3);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 3, turnsSinceLastWrite: 3, threshold: 3,
    });
    const ctx = fired.output?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain(
      "[Vibehub] Knowledge checkpoint: 3 user turns on this task with no knowledge captured yet",
    );
    expect(ctx).toContain("vibehub-ingest");
    expect(ctx).toContain(`attribute the write to task ${taskBranch}`);
    expect(ctx).toContain("do not create filler records");
    expect(prompt(4).checkpoint?.status).toBe("counted");
    expect(prompt(5).checkpoint?.status).toBe("counted");
    const again = prompt(6);
    expect(again.checkpoint).toEqual({
      status: "fired", countedTurns: 6, turnsSinceLastWrite: 6, threshold: 3,
    });
    expect(again.output?.hookSpecificOutput?.additionalContext).toContain("6 user turns");
  });

  it("never counts or fires a replayed prompt event (stable prompt identity)", () => {
    prompt(1);
    const beforeReplay = readTimeline(db, taskBranch);
    enqueueInjection(db, 1, taskBranch, "inject", "arrived after turn 1", T(2).toISOString());
    const dup = ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ prompt: "turn 1", prompt_id: "p-1" }),
      { now: () => T(2) },
    );
    expect(dup.checkpoint).toEqual({
      status: "duplicate", countedTurns: 1, turnsSinceLastWrite: 1, threshold: 3,
    });
    expect(dup.eventTypesWritten).toEqual([]);
    expect(readTimeline(db, taskBranch)).toEqual(beforeReplay);
    expect(pendingInjections(db, taskBranch)).toMatchObject([
      { text: "arrived after turn 1" },
    ]);
    db.prepare("DELETE FROM injections WHERE task_id = ?").run(taskBranch);
    prompt(3);
    const fired = prompt(4);
    expect(fired.checkpoint?.status).toBe("fired");
    const replayAfterFire = ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ prompt: "turn 4", prompt_id: "p-4" }),
      { now: () => T(5) },
    );
    expect(replayAfterFire.checkpoint?.status).toBe("duplicate");
    expect(replayAfterFire.output).toBeUndefined();
  });

  it("does not count prompts without a stable prompt identity (honest degradation)", () => {
    const noId = ingestHookEvent(
      db, "UserPromptSubmit", payload({ prompt: "no id" }), { now: () => T(1) },
    );
    const garbageId = ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ prompt: "bad id", prompt_id: 42 as unknown as string }),
      { now: () => T(2) },
    );
    expect(noId.checkpoint).toBeUndefined();
    expect(garbageId.checkpoint).toBeUndefined();
    expect(count("task_prompt_cadence")).toBe(0);
    expect(count("task_prompt_seen")).toBe(0);
    expect(readTimeline(db, taskBranch).filter((e) => e.type === "launch")).toHaveLength(1);
  });

  it("keeps cadence isolated per task, even reusing the same prompt ids", () => {
    const wt = path.join(repo.root, "wt");
    git(repo.work, "worktree", "add", "-b", "vibehub/wt-task", wt);
    ingestHookEvent(db, "SessionStart", payload({ cwd: wt, session_id: "sess-wt" }), { now: () => T(0) });
    prompt(1);
    prompt(2);
    const wtPrompt = ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ cwd: wt, session_id: "sess-wt", prompt: "wt turn", prompt_id: "p-1" }),
      { now: () => T(3) },
    );
    expect(wtPrompt.checkpoint).toEqual({
      status: "counted", countedTurns: 1, turnsSinceLastWrite: 1, threshold: 3,
    });
    const mainFired = prompt(4);
    expect(mainFired.checkpoint?.status).toBe("fired");
    expect(cadenceRow(taskIdForBranch(1, "vibehub/wt-task"))).toMatchObject({
      countedTurns: 1, lastReminderTurn: 0,
    });
  });

  it("keeps cadence isolated per repository for identical branch names", () => {
    const repoB = makeScratchRepo();
    try {
      git(repoB.work, "checkout", "-b", "vibehub/fix-login");
      const startB = ingestHookEvent(
        db, "SessionStart", { session_id: "sess-b", cwd: repoB.work }, { now: () => T(0) },
      );
      const promptB = (n: number) => ingestHookEvent(
        db,
        "UserPromptSubmit",
        { session_id: "sess-b", cwd: repoB.work, prompt: `b turn ${n}`, prompt_id: `p-${n}` },
        { now: () => T(n) },
      );
      prompt(1);
      prompt(2);
      promptB(1);
      promptB(2);
      const firedA = prompt(3);
      expect(firedA.checkpoint?.status).toBe("fired");
      expect(startB.taskId).not.toBe(taskBranch);
      expect(cadenceRow(startB.taskId)).toMatchObject({ countedTurns: 2, lastReminderTurn: 0 });
      const firedB = promptB(5);
      expect(firedB.checkpoint).toEqual({
        status: "fired", countedTurns: 3, turnsSinceLastWrite: 3, threshold: 3,
      });
    } finally {
      repoB.cleanup();
    }
  });

  it("persists cadence across process restarts (same SQLite file)", () => {
    prompt(1);
    prompt(2);
    db.close();
    db = openDb(dbPath);
    const fired = prompt(3);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 3, turnsSinceLastWrite: 3, threshold: 3,
    });
  });

  it("resets mechanically after a successful canonical knowledge write", () => {
    prompt(1);
    prompt(2);
    const repoId = getRepoByRoot(db, repo.work)!.id;
    new KnowledgeService(db).applyDraftBatch(
      repoId,
      draftBatch("capture-1", "spec-checkpoint-1"),
      mutationCtx("req-cp-1", 3, taskBranch),
    );
    const afterWrite = prompt(4);
    expect(afterWrite.checkpoint).toEqual({
      status: "counted", countedTurns: 3, turnsSinceLastWrite: 1, threshold: 3,
    });
    expect(cadenceRow(taskBranch)).toMatchObject({ lastWriteTurn: 2 });
    prompt(5);
    const fired = prompt(6);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 5, turnsSinceLastWrite: 3, threshold: 3,
    });
    expect(fired.output?.hookSpecificOutput?.additionalContext).toContain(
      "3 user turns on this task since the last captured knowledge write",
    );
  });

  it("does not reset on a failed write — the error receipt row is inert", () => {
    prompt(1);
    prompt(2);
    const repoId = getRepoByRoot(db, repo.work)!.id;
    const failed = new OperationDispatcher(db).dispatch(
      "kb.draft.apply",
      { repoId, actor: "agent", taskId: taskBranch, requestId: "req-bad", now: T(3).toISOString() },
      { idempotencyKey: "bad", specs: [] },
    );
    expect(failed.ok).toBe(false);
    expect(db.prepare(
      `SELECT outcome_kind AS kind FROM operation_request_receipts WHERE request_id = 'req-bad'`,
    ).get()).toEqual({ kind: "error" });
    expect(count("kb_provenance_events")).toBe(0);
    const fired = prompt(3);
    expect(fired.checkpoint?.status).toBe("fired");
  });

  it("does not reset on an idempotent replay of a canonical write", () => {
    prompt(1);
    prompt(2);
    const repoId = getRepoByRoot(db, repo.work)!.id;
    const service = new KnowledgeService(db);
    service.applyDraftBatch(
      repoId, draftBatch("capture-1", "spec-checkpoint-1"), mutationCtx("req-1", 3, taskBranch),
    );
    prompt(4);
    const provenanceBefore = count("kb_provenance_events");
    service.applyDraftBatch(
      repoId, draftBatch("capture-1", "spec-checkpoint-1"), mutationCtx("req-2", 5, taskBranch),
    );
    expect(count("kb_provenance_events")).toBe(provenanceBefore);
    expect(prompt(6).checkpoint?.status).toBe("counted");
    const fired = prompt(7);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 5, turnsSinceLastWrite: 3, threshold: 3,
    });
  });

  it("ignores canonical writes not attributed to this task (other task or none)", () => {
    prompt(1);
    prompt(2);
    const repoId = getRepoByRoot(db, repo.work)!.id;
    const service = new KnowledgeService(db);
    service.applyDraftBatch(
      repoId, draftBatch("other-capture", "spec-other"), mutationCtx("req-other", 3, "task:elsewhere"),
    );
    service.mutate(
      repoId,
      "promote",
      { specId: "spec-other", idempotencyKey: "promote-other" },
      mutationCtx("req-promote", 4),
    );
    expect(count("kb_provenance_events")).toBeGreaterThan(0);
    const fired = prompt(5);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 3, turnsSinceLastWrite: 3, threshold: 3,
    });
  });

  it("defers to claimed interventions and a duplicate can never ride the same turn", () => {
    prompt(1);
    prompt(2);
    const repoId = getRepoByRoot(db, repo.work)!.id;
    enqueueInjection(db, repoId, taskBranch, "pause", "Stop — let's talk.", T(3).toISOString());
    const paused = prompt(4);
    const ctx = paused.output?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("[Vibehub] PAUSE from your user:");
    expect(ctx).not.toContain("Knowledge checkpoint");
    expect(paused.checkpoint?.status).toBe("deferred");
    expect(cadenceRow(taskBranch)).toMatchObject({ lastReminderTurn: 0 });
    const dup = ingestHookEvent(
      db,
      "UserPromptSubmit",
      payload({ prompt: "turn 4", prompt_id: "p-4" }),
      { now: () => T(5) },
    );
    expect(dup.checkpoint?.status).toBe("duplicate");
    expect(dup.output).toBeUndefined();
    const fired = prompt(6);
    expect(fired.checkpoint).toEqual({
      status: "fired", countedTurns: 4, turnsSinceLastWrite: 4, threshold: 3,
    });
    expect(fired.output?.hookSpecificOutput?.additionalContext).toContain("Knowledge checkpoint");
  });

  it("only injects text when firing — no knowledge rows are fabricated", () => {
    prompt(1);
    prompt(2);
    const fired = prompt(3);
    expect(fired.checkpoint?.status).toBe("fired");
    expect(count("kb_specs")).toBe(0);
    expect(count("kb_provenance_events")).toBe(0);
    expect(count("kb_mutation_receipts")).toBe(0);
  });

  it("seeds the provenance high-water at first sight — old writes are baseline", () => {
    const repoId = getRepoByRoot(db, repo.work)!.id;
    new KnowledgeService(db).applyDraftBatch(
      repoId, draftBatch("pre-existing", "spec-pre"), mutationCtx("req-pre", 0, taskBranch),
    );
    const first = prompt(1);
    expect(first.checkpoint).toEqual({
      status: "counted", countedTurns: 1, turnsSinceLastWrite: 1, threshold: 3,
    });
    expect(cadenceRow(taskBranch)).toMatchObject({ lastWriteTurn: 0 });
    expect(cadenceRow(taskBranch)!.provenanceHighWater).toBeGreaterThan(0);
    prompt(2);
    expect(prompt(3).checkpoint?.status).toBe("fired");
  });
});

describe("lastAssistantText", () => {
  it("returns null for a missing file", () => {
    expect(lastAssistantText("/nope/nothing.jsonl")).toBeNull();
  });
  it("skips trailing non-assistant entries and joins text blocks", () => {
    const p = path.join(os.tmpdir(), `vibehub-tt-${process.pid}.jsonl`);
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "First." }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Second A." }, { type: "text", text: "Second B." }] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
        "not json at all",
        "",
      ].join("\n"),
    );
    expect(lastAssistantText(p)).toBe("Second A.\nSecond B.");
    fs.rmSync(p);
  });
});
