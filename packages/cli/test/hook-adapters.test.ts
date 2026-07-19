import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueInjection,
  getRepoByRoot,
  ingestCanonicalHookEvent,
  openDb,
  pendingInjections,
  readFootprints,
  readTimeline,
  sessionIdentity,
} from "@vibehub/core";
import {
  adaptCodexHook,
  codexApplyPatchTouches,
  projectClaudeCodeHookOutput,
  projectCodexHookOutput,
} from "../src/hook-adapters.js";
import { main } from "../src/main.js";

describe("host hook adapters", () => {
  let root: string;
  let repo: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-host-hooks-"));
    repo = path.join(root, "repo");
    dbPath = path.join(root, "workbench.db");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("namespaces Codex session and prompt identities and attributes the agent", () => {
    const start = adaptCodexHook("SessionStart", {
      session_id: "session-1",
      transcript_path: null,
      cwd: repo,
      hook_event_name: "SessionStart",
      model: "gpt-5",
      permission_mode: "default",
      source: "startup",
    });
    expect(start.kind).toBe("event");
    if (start.kind !== "event") throw new Error("unexpected ignored start");
    expect(start.event).toMatchObject({
      host: "codex",
      sessionId: "codex:session-1",
    });

    const db = openDb(dbPath);
    const started = ingestCanonicalHookEvent(db, start.event);
    const prompt = adaptCodexHook("UserPromptSubmit", {
      session_id: "session-1",
      turn_id: "turn-7",
      transcript_path: null,
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5",
      permission_mode: "default",
      prompt: "Keep the API stable.",
    });
    if (prompt.kind !== "event") throw new Error("unexpected ignored prompt");
    expect(prompt.event.promptIdentity).toBe("codex:session-1:turn-7");
    ingestCanonicalHookEvent(db, prompt.event);

    expect(sessionIdentity(db, started.taskId, "codex:session-1")?.agent).toBe("Codex");
    expect(readTimeline(db, started.taskId)[0]).toMatchObject({
      type: "launch",
      promptId: "codex:session-1:turn-7",
    });
    db.close();
  });

  it("mechanically extracts every apply_patch source and move destination", () => {
    expect(codexApplyPatchTouches(
      "*** Begin Patch\n" +
      "*** Update File: src/a.ts\n" +
      "*** Move to: src/b.ts\n" +
      "@@\n-old\n+new\n" +
      "*** Add File: src/c.ts\n" +
      "+content\n" +
      "*** Delete File: src/d.ts\n" +
      "*** End Patch\n",
    )).toEqual([
      { action: "edit", path: "src/a.ts" },
      { action: "edit", path: "src/b.ts" },
      { action: "edit", path: "src/c.ts" },
      { action: "edit", path: "src/d.ts" },
    ]);
  });

  it("accepts raw-string apply_patch input and rejects missing Codex turn identity", () => {
    const rawPatch = adaptCodexHook("PostToolUse", {
      session_id: "s",
      turn_id: "t",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: "*** Begin Patch\n*** Update File: src/raw.ts\n*** End Patch\n",
    });
    expect(rawPatch).toMatchObject({
      kind: "event",
      event: { toolTouches: [{ action: "edit", path: "src/raw.ts" }] },
    });
    expect(() => adaptCodexHook("UserPromptSubmit", {
      session_id: "s",
      cwd: repo,
      hook_event_name: "UserPromptSubmit",
      prompt: "missing turn",
    })).toThrow(/turn_id/);
  });

  it("writes all Codex apply_patch footprints through one atomic core event", () => {
    const db = openDb(dbPath);
    const start = adaptCodexHook("SessionStart", {
      session_id: "s", cwd: repo, hook_event_name: "SessionStart",
    });
    if (start.kind !== "event") throw new Error("unexpected ignored start");
    const started = ingestCanonicalHookEvent(db, start.event);
    const post = adaptCodexHook("PostToolUse", {
      session_id: "s",
      turn_id: "t",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n" +
          "*** Add File: src/b.ts\n+b\n*** End Patch\n",
      },
    });
    if (post.kind !== "event") throw new Error("unexpected ignored post tool");
    ingestCanonicalHookEvent(db, post.event);
    expect(readFootprints(db, started.taskId).map((row) => row.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    db.close();
  });

  it("validates every apply_patch path before claiming an intervention", () => {
    const db = openDb(dbPath);
    const start = adaptCodexHook("SessionStart", {
      session_id: "s", cwd: repo, hook_event_name: "SessionStart",
    });
    if (start.kind !== "event") throw new Error("unexpected ignored start");
    const started = ingestCanonicalHookEvent(db, start.event);
    const repoId = getRepoByRoot(db, fs.realpathSync(repo))!.id;
    enqueueInjection(db, repoId, started.taskId, "inject", "preserve", new Date().toISOString());
    const post = adaptCodexHook("PostToolUse", {
      session_id: "s",
      turn_id: "t",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n" +
          "*** Add File: ../outside.ts\n+x\n*** End Patch\n",
      },
    });
    if (post.kind !== "event") throw new Error("unexpected ignored post tool");
    expect(() => ingestCanonicalHookEvent(db, post.event)).toThrow(/outside|escapes/);
    expect(readFootprints(db, started.taskId)).toEqual([]);
    expect(pendingInjections(db, started.taskId)).toMatchObject([{ text: "preserve" }]);
    db.close();
  });

  it("ignores attributed Codex subagent prompt/tool events before any claim or write", () => {
    const db = openDb(dbPath);
    const start = adaptCodexHook("SessionStart", {
      session_id: "root", cwd: repo, hook_event_name: "SessionStart",
    });
    if (start.kind !== "event") throw new Error("unexpected ignored start");
    const started = ingestCanonicalHookEvent(db, start.event);
    const repoId = getRepoByRoot(db, fs.realpathSync(repo))!.id;
    enqueueInjection(db, repoId, started.taskId, "inject", "root only", new Date().toISOString());
    const before = readTimeline(db, started.taskId).length;

    const subagent = adaptCodexHook("PostToolUse", {
      session_id: "child",
      turn_id: "child-turn",
      agent_id: "agent-1",
      agent_type: "worker",
      cwd: repo,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\n" },
    });
    expect(subagent).toEqual({ kind: "ignored", reason: "codex_subagent_event" });
    expect(pendingInjections(db, started.taskId)).toHaveLength(1);
    expect(readTimeline(db, started.taskId)).toHaveLength(before);
    expect(readFootprints(db, started.taskId)).toEqual([]);
    db.close();
  });

  it("pins separate Claude and Codex wire projectors", () => {
    const context = {
      kind: "additional_context" as const,
      hookEventName: "SessionStart" as const,
      additionalContext: "protocol",
    };
    expect(projectClaudeCodeHookOutput(context)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "protocol" },
    });
    expect(projectCodexHookOutput(context)).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "protocol" },
    });
    const stop = { kind: "continue_turn" as const, reason: "continue" };
    expect(projectClaudeCodeHookOutput(stop)).toEqual({ decision: "block", reason: "continue" });
    expect(projectCodexHookOutput(stop)).toEqual({ decision: "block", reason: "continue" });
  });

  it("keeps legacy CLI hooks Claude by default and accepts --host codex", () => {
    let stdout = "";
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { stdout += String(line); });
    vi.spyOn(fs, "readFileSync").mockReturnValueOnce(JSON.stringify({
      session_id: "legacy", cwd: repo, hook_event_name: "SessionStart",
    }));
    expect(main(["hook", "SessionStart", "--db", dbPath])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });

    stdout = "";
    vi.spyOn(fs, "readFileSync").mockReturnValueOnce(JSON.stringify({
      session_id: "native", cwd: repo, hook_event_name: "SessionStart",
    }));
    expect(main(["hook", "SessionStart", "--host", "codex", "--db", dbPath])).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });

    const db = openDb(dbPath);
    const agents = db.prepare("SELECT id, agent FROM sessions ORDER BY id").all();
    expect(agents).toEqual([
      { id: "codex:native", agent: "Codex" },
      { id: "legacy", agent: "Claude Code" },
    ]);
    db.close();
  });
});
