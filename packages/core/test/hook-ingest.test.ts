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
  pendingInjections,
  readFootprints,
  readTask,
  readTimeline,
  sessionIdentity,
} from "../src/activity-store.js";
import { getRepoByRoot } from "../src/team-store.js";
import { replaceScopePatterns } from "../src/scope-registry.js";
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
    taskBranch = "branch:vibehub/fix-login";
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

    const task = readTask(db, "branch:vibehub/wt-task")!;
    expect(task.worktreePath).toBe(wt);
    // one repo domain: the worktree session's repo row is the MAIN root
    expect(getRepoByRoot(db, repo.work)).not.toBeNull();
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
