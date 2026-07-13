import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  openDb,
  readTask,
  readScopePatterns,
  readSpec,
  retrieveKnowledge,
  upsertRepo,
  upsertTask,
  type Db,
} from "@vibehub/core";
import { createCapabilities } from "../src/capabilities.js";
import { openRuntimeContext } from "../src/runtime.js";

const NOW = "2026-07-12T10:00:00.000Z";

describe("local MCP deterministic capabilities", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-mcp-"));
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, "/repo", null, "main", NOW);
    upsertTask(db, {
      id: "branch:feat/mcp", repoId: 1, title: "mcp", state: "running",
      signalTier: "hooks", branch: "feat/mcp", worktreePath: null,
      prNumber: null, prState: null, stateSince: NOW, lastEventAt: NOW,
      statusDetail: null, createdAt: NOW, startHeadSha: "abc123",
    });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("register_scope stores raw globs rather than territory ids", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    api.registerScope({
      status: "building MCP",
      write: [{ glob: "workbench/packages/mcp/**", label: "MCP" }],
      read: [{ glob: "META/21-workbench/**" }],
    });
    expect(readScopePatterns(db, "branch:feat/mcp").map((p) => p.glob)).toEqual([
      "workbench/packages/mcp/**", "META/21-workbench/**",
    ]);
  });

  it("kb_record accepts seven types and generates the id server-side", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    const result = api.kbRecord({ type: "contract", summary: "MCP stays deterministic" });
    if (!("spec" in result)) throw new Error("expected recorded spec");
    expect(result.spec.id).toMatch(/^contract-/);
    expect(readSpec(db, result.spec.id)?.state).toBe("draft");
    expect(api.kbRecord({ marksStale: result.spec.id })).toEqual({
      markedStale: result.spec.id,
    });
    expect(readSpec(db, result.spec.id)?.state).toBe("stale");
  });

  it("kb_apply_distillation is an atomic manifest apply boundary", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    api.kbApplyDistillation({
      features: [{ id: "mcp", name: "MCP" }],
      anchors: [{ featureId: "mcp", file: "workbench/packages/mcp/src/server.ts" }],
      relations: [],
    });
    expect(retrieveKnowledge(db, 1, { paths: ["workbench/packages/mcp/src/server.ts"] })).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM features").get()).toEqual({ n: 1 });
  });

  it("self_report stores a one-line status and get_manual stays reference-only", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    expect(api.selfReport({ status: "MCP spine is green", done: "scope registry" })).toEqual({
      status: "MCP spine is green", done: "scope registry", reportedAt: NOW,
    });
    expect(api.getManual({ topic: "skills" }).text).toContain("skills own semantic workflow");
  });
});

describe("MCP runtime context", () => {
  let repo: string;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-mcp-runtime-"));
    repo = path.join(dir, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
    execFileSync("git", ["checkout", "-b", "feat/runtime"], { cwd: repo });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("derives repo and task from the server cwd without a second config source", () => {
    const runtime = openRuntimeContext(repo, path.join(dir, "runtime.db"), () => NOW);
    expect(runtime.context.taskId).toBe("branch:feat/runtime");
    expect(runtime.context.repoId).toBe(1);
    expect(readTask(runtime.context.db, runtime.context.taskId)?.startHeadSha).toMatch(/^[0-9a-f]{40}$/);
    runtime.close();
  });
});
