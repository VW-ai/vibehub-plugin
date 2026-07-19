import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectActivation,
  inspectProjectActivation,
  openDb,
  operationProvesContextValue,
  PROJECT_INSTRUCTION_END,
  PROJECT_INSTRUCTION_START,
  readProjectActivationStatus,
  sha256,
  upsertSession,
  upsertTask,
  type ManagedAssetManifest,
  type ProjectActivationOptions,
} from "../src/index.js";
import { git, makeScratchRepo } from "./helpers.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup(): ProjectActivationOptions & { repo: string; db: string } {
  const scratch = makeScratchRepo();
  roots.push(scratch.root);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "vh-activation-"));
  roots.push(state);
  const plugin = path.join(state, "plugin");
  fs.mkdirSync(plugin);
  const content = "managed\n";
  const manifest: ManagedAssetManifest = {
    schemaVersion: 1,
    releaseVersion: "1",
    assets: [{
      source: "builtin://hook",
      target: path.join(plugin, "hook.mjs"),
      content,
      checksum: sha256(content),
      version: "1",
      repairPolicy: "replace-managed",
    }],
  };
  const db = path.join(state, "workbench.db");
  return {
    repo: scratch.work,
    db,
    repoPath: scratch.work,
    dbPath: db,
    stateDir: state,
    allowedAssetRoot: plugin,
    manifest,
    now: () => new Date("2026-07-18T00:00:00.000Z"),
  };
}
const debris = (repo: string) => fs.readdirSync(repo).filter((name) => name.includes(".vibehub-"));
function addHostSession(
  db: ReturnType<typeof openDb>,
  repoId: number,
  repoRoot: string,
  checkout: string,
  id: string,
  startedAt: string,
): void {
  const taskId = `task-${id}`;
  upsertTask(db, {
    id: taskId, repoId, title: id, state: "running", signalTier: "hooks", branch: id,
    worktreePath: checkout === repoRoot ? null : checkout, prNumber: null, prState: null,
    stateSince: startedAt, lastEventAt: startedAt, statusDetail: null, createdAt: startedAt, startHeadSha: null,
  });
  upsertSession(db, {
    id, repoId, taskId, agent: "Claude Code", transcriptPath: null,
    startedAt, endedAt: null, endReason: null,
  });
}
describe("project activation primitives", () => {
  it("blocks non-git before any DB or file side effect and keeps inspect read-only", () => {
    const x = setup();
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vh-plain-"));
    roots.push(plain);
    expect(applyProjectActivation({ ...x, repoPath: plain })).toMatchObject({
      ok: false, outcome: "blocked", errors: [{ code: "not_git_repository" }],
    });
    expect(fs.readdirSync(plain)).toEqual([]);
    expect(fs.existsSync(x.db)).toBe(false);
    const before = fs.readdirSync(x.repo).sort();
    expect(inspectProjectActivation(x)).toMatchObject({
      schemaVersion: 1, command: "inspect", outcome: "changes_required",
      instructions: [{ status: "missing" }, { status: "missing" }],
    });
    expect(fs.readdirSync(x.repo).sort()).toEqual(before);
    expect(fs.existsSync(x.db)).toBe(false);
  });
  it("appends byte-preservingly and a current rerun does not touch hashes or mtimes", () => {
    const x = setup();
    fs.writeFileSync(path.join(x.repo, "AGENTS.md"), "agents-no-newline");
    fs.writeFileSync(path.join(x.repo, "CLAUDE.md"), "claude\n");
    expect(applyProjectActivation(x).ok).toBe(true);
    expect(fs.readFileSync(path.join(x.repo, "AGENTS.md"), "utf8"))
      .toMatch(new RegExp(`^agents-no-newline\\n${PROJECT_INSTRUCTION_START}`));
    const files = ["AGENTS.md", "CLAUDE.md"].map((name) => path.join(x.repo, name));
    const before = files.map((file) => [sha256(fs.readFileSync(file)), fs.statSync(file).mtimeMs]);
    expect(applyProjectActivation(x).outcome).toBe("unchanged");
    expect(files.map((file) => [sha256(fs.readFileSync(file)), fs.statSync(file).mtimeMs])).toEqual(before);
  });
  it("upgrades only the managed slice and preserves exact prefix/suffix bytes", () => {
    const x = setup();
    applyProjectActivation({ ...x, instructionVersion: "1", instructionBody: "old" });
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = path.join(x.repo, name);
      fs.writeFileSync(file, Buffer.concat([
        Buffer.from("prefix\u0000"),
        fs.readFileSync(file),
        Buffer.from("suffix\u0000"),
      ]));
    }
    expect(applyProjectActivation({ ...x, instructionVersion: "2", instructionBody: "new" }).ok).toBe(true);
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const value = fs.readFileSync(path.join(x.repo, name));
      expect(value.subarray(0, 7).equals(Buffer.from("prefix\u0000"))).toBe(true);
      expect(value.subarray(-7).equals(Buffer.from("suffix\u0000"))).toBe(true);
      expect(value.toString()).toContain("VIBEHUB:VERSION 2");
    }
  });
  it.each([
    `${PROJECT_INSTRUCTION_START}\nx`,
    `x\n${PROJECT_INSTRUCTION_END}`,
    `${PROJECT_INSTRUCTION_END}\nx\n${PROJECT_INSTRUCTION_START}`,
    `${PROJECT_INSTRUCTION_START}\nx\n${PROJECT_INSTRUCTION_START}\n${PROJECT_INSTRUCTION_END}`,
  ])("blocks malformed marker topology without writing the other file or DB", (content) => {
    const x = setup();
    fs.writeFileSync(path.join(x.repo, "AGENTS.md"), content);
    expect(applyProjectActivation(x)).toMatchObject({
      ok: false, outcome: "blocked", errors: [{ code: "instruction_conflict" }],
    });
    expect(fs.existsSync(path.join(x.repo, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(x.db)).toBe(false);
  });
  it("rejects symlink/directory targets in one full preflight", () => {
    const x = setup();
    const external = path.join(path.dirname(x.repo), "external.md");
    fs.writeFileSync(external, "external");
    fs.symlinkSync(external, path.join(x.repo, "AGENTS.md"));
    fs.mkdirSync(path.join(x.repo, "CLAUDE.md"));
    const result = applyProjectActivation(x);
    expect(result.instructions.map((item) => item.status)).toEqual(["conflict", "conflict"]);
    expect(fs.readFileSync(external, "utf8")).toBe("external");
    expect(fs.existsSync(x.db)).toBe(false);
  });
  it("rolls back exact content and clears debris after the first rename fault", () => {
    const x = setup();
    fs.writeFileSync(path.join(x.repo, "AGENTS.md"), "agents-original");
    fs.writeFileSync(path.join(x.repo, "CLAUDE.md"), "claude-original");
    const result = applyProjectActivation({
      ...x,
      instructionFault: ({ phase, committedTargets }) => {
        if (phase === "after-target-rename" && committedTargets === 1) throw new Error("fault");
      },
    });
    expect(result.outcome).toBe("partial");
    expect(fs.readFileSync(path.join(x.repo, "AGENTS.md"), "utf8")).toBe("agents-original");
    expect(fs.readFileSync(path.join(x.repo, "CLAUDE.md"), "utf8")).toBe("claude-original");
    expect(result.instructions.every((item) => item.changed === false)).toBe(true);
    expect(debris(x.repo)).toEqual([]);
  });
  it("reports a deterministic staging failure with zero mutation", () => {
    const x = setup();
    const result = applyProjectActivation({
      ...x,
      instructionFault: ({ phase }) => { if (phase === "before-stage") throw new Error("denied"); },
    });
    expect(result).toMatchObject({
      outcome: "blocked", errors: [{ code: "instruction_staging_failed", message: "denied" }],
    });
    expect(result.instructions.every((item) => item.changed === false)).toBe(true);
    expect(fs.existsSync(x.db)).toBe(false);
    expect(fs.existsSync(path.join(x.repo, "AGENTS.md"))).toBe(false);
    expect(debris(x.repo)).toEqual([]);
  });
  it("does not equate doctor green, status, empty query, or failure with Activated", () => {
    const x = setup();
    applyProjectActivation(x);
    const blockTime = new Date("2026-07-18T00:00:00.000Z");
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      fs.utimesSync(path.join(x.repo, file), blockTime, blockTime);
    }
    let status = readProjectActivationStatus(x);
    expect(status.activation).toMatchObject({
      installed: { state: "proven" },
      connected: { state: "not_proven" },
      activated: { state: "not_proven" },
    });
    const repoId = status.runtime!.repo.id!;
    const db = openDb(x.db);
    const insert = db.prepare(
      `INSERT INTO operation_request_receipts
       (repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    const success = (requestId: string, operation: string, data: unknown) =>
      JSON.stringify({ ok: true, data, meta: { operation, repoId, requestId, at: "2026-07-18T00:00:00.000Z" } });
    const failure = JSON.stringify({ ok: false, error: { code: "not_found", message: "no", details: null, nextSafeActions: [] } });
    insert.run(repoId, "old-value", "kb.spec.search", "h0", "success", success("old-value", "kb.spec.search", { total: 1, items: [{ id: "old" }] }), "2026-07-18T00:00:30.000Z");
    addHostSession(db, repoId, x.repo, x.repo, "equal-session", "2026-07-18T00:00:00.000Z");
    db.prepare(
      `INSERT INTO sessions(id,repo_id,task_id,agent,started_at) VALUES(?,?,NULL,?,?)`,
    ).run("legacy-session", repoId, "Claude Code", "2026-07-18T00:00:40.000Z");
    db.close();
    status = readProjectActivationStatus(x);
    expect(status.activation.connected.state).toBe("not_proven");
    const db1 = openDb(x.db);
    addHostSession(db1, repoId, x.repo, x.repo, "host-session", "2026-07-18T00:01:00.000Z");
    db1.close();
    status = readProjectActivationStatus(x);
    expect(status.activation).toMatchObject({
      connected: {
        state: "proven",
        evidence: expect.arrayContaining(["host hook session observed:host-session@2026-07-18T00:01:00.000Z"]),
      },
      activated: { state: "not_proven" },
    });
    const db2 = openDb(x.db);
    const insert2 = db2.prepare(
      `INSERT INTO operation_request_receipts
       (repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    insert2.run(repoId, "equal-value", "kb.spec.search", "he", "success", success("equal-value", "kb.spec.search", { total: 1, items: [{ id: "equal" }] }), "2026-07-18T00:01:00.000Z");
    insert2.run(repoId, "status", "kb.status", "h1", "success", success("status", "kb.status", {}), "2026-07-18T00:01:10.000Z");
    insert2.run(repoId, "empty", "kb.spec.search", "h2", "success", success("empty", "kb.spec.search", { total: 0, items: [] }), "2026-07-18T00:01:20.000Z");
    insert2.run(repoId, "failed", "kb.spec.get", "h3", "error", failure, "2026-07-18T00:01:30.000Z");
    db2.close();
    expect(readProjectActivationStatus(x).activation.activated.state).toBe("not_proven");
    const db3 = openDb(x.db);
    db3.prepare(
      `INSERT INTO operation_request_receipts
       (repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(repoId, "value", "kb.spec.search", "h4", "success", success("value", "kb.spec.search", { total: 1, items: [{ id: "s" }] }), "2026-07-18T00:02:00.000Z");
    db3.close();
    expect(readProjectActivationStatus(x).activation.activated)
      .toMatchObject({ state: "proven", evidence: ["kb.spec.search:value"] });
  });
  it("uses explicit per-operation value validators", () => {
    const cases: Array<[string, unknown, unknown]> = [
      ["kb.feature.list", [{ id: "f" }], []],
      ["kb.feature.suggest", [{ id: "f" }], []],
      ["kb.spec.search", { total: 1, items: [{ id: "s" }] }, { total: 1, items: [] }],
      ["kb.feature.get", { id: "f" }, { name: "F" }],
      ["kb.spec.get", { id: "s" }, { summary: "S" }],
      ["kb.relations", { edges: [{ fromSpecId: "a" }] }, { root: "a", edges: [] }],
      ["kb.lineage", { chain: ["a"] }, { chain: [] }],
      ["kb.anchors", { forward: [{ file: "a.ts" }] }, { forward: [] }],
      ["kb.draft.apply", { operation: "draft_batch", idempotencyKey: "k", created: ["s"] }, null],
    ];
    for (const [operation, positive, negative] of cases) {
      expect(operationProvesContextValue(operation, positive), `${operation} positive`).toBe(true);
      expect(operationProvesContextValue(operation, negative), `${operation} negative`).toBe(false);
    }
    expect(operationProvesContextValue("kb.status", { total: 99, items: [{ id: "x" }] })).toBe(false);
    expect(operationProvesContextValue("kb.draft.apply", { operation: "draft_batch", idempotencyKey: "k", created: [] })).toBe(false);
  });
  it.each([
    { instructionVersion: "bad\nversion", instructionBody: "safe" },
    { instructionVersion: "1", instructionBody: `collision ${PROJECT_INSTRUCTION_START}` },
    { instructionVersion: "1", instructionBody: `collision ${PROJECT_INSTRUCTION_END}` },
    { instructionVersion: "1", instructionBody: "collision <!-- VIBEHUB:VERSION 9 -->" },
  ])("rejects unsafe managed content before DB or file mutation", (override) => {
    const x = setup();
    const result = applyProjectActivation({ ...x, ...override });
    expect(result).toMatchObject({
      ok: false, outcome: "blocked", errors: [{ code: "invalid_instruction_content" }],
      instructions: [], runtime: null, init: null,
    });
    expect(fs.existsSync(x.db)).toBe(false);
    expect(fs.existsSync(path.join(x.repo, "AGENTS.md"))).toBe(false);
  });
  it("rolls back when final verification throws, before the commit point", () => {
    const x = setup();
    fs.writeFileSync(path.join(x.repo, "AGENTS.md"), "agents-original");
    fs.writeFileSync(path.join(x.repo, "CLAUDE.md"), "claude-original");
    const result = applyProjectActivation({
      ...x,
      instructionFault: ({ phase }) => {
        if (phase === "before-final-verification") throw new Error("verify fault");
      },
    });
    expect(result).toMatchObject({ ok: false, outcome: "partial", errors: [{ code: "instruction_commit_failed" }] });
    expect(fs.readFileSync(path.join(x.repo, "AGENTS.md"), "utf8")).toBe("agents-original");
    expect(fs.readFileSync(path.join(x.repo, "CLAUDE.md"), "utf8")).toBe("claude-original");
    expect(debris(x.repo)).toEqual([]);
  });
  it("never rolls back committed files when backup cleanup partially fails", () => {
    const x = setup();
    fs.writeFileSync(path.join(x.repo, "AGENTS.md"), "agents-original");
    fs.writeFileSync(path.join(x.repo, "CLAUDE.md"), "claude-original");
    const result = applyProjectActivation({
      ...x,
      instructionFault: ({ phase, committedTargets }) => {
        if (phase === "before-backup-cleanup" && committedTargets === 2) throw new Error("cleanup fault");
      },
    });
    expect(result).toMatchObject({ ok: false, outcome: "partial", errors: [{ code: "backup_cleanup_failed" }] });
    expect(fs.readFileSync(path.join(x.repo, "AGENTS.md"), "utf8")).toContain(PROJECT_INSTRUCTION_START);
    expect(fs.readFileSync(path.join(x.repo, "CLAUDE.md"), "utf8")).toContain(PROJECT_INSTRUCTION_START);
    const backups = debris(x.repo).filter((name) => name.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(x.repo, backups[0]!), "utf8")).toBe("claude-original");
  });
  it("returns complete typed results when doctor, init, or proof throws", () => {
    for (const command of ["inspect", "status"] as const) {
      const x = setup();
      const result = command === "inspect"
        ? inspectProjectActivation({ ...x, instructionFault: ({ phase }) => { if (phase === "before-doctor") throw new Error("doctor"); } })
        : readProjectActivationStatus({ ...x, instructionFault: ({ phase }) => { if (phase === "before-proof") throw new Error("proof"); } });
      expect(result).toMatchObject({
        schemaVersion: 1, command, ok: false, outcome: "blocked",
        repo: { root: x.repo, toplevel: x.repo }, instructions: [], runtime: null, init: null,
        activation: { installed: { state: "blocked" }, connected: { state: "blocked" }, activated: { state: "blocked" } },
        errors: [{ code: "runtime_failed" }],
      });
    }
    const x = setup();
    const applied = applyProjectActivation({
      ...x,
      instructionFault: ({ phase }) => { if (phase === "before-runtime-init") throw new Error("init"); },
    });
    expect(applied).toMatchObject({
      schemaVersion: 1, command: "apply", ok: false, outcome: "blocked",
      repo: { root: x.repo, toplevel: x.repo }, runtime: null, init: null,
      activation: { installed: { state: "blocked" } }, errors: [{ code: "runtime_failed" }],
    });
    expect(applied.instructions.every((item) => item.changed === false)).toBe(true);
    expect(fs.existsSync(x.db)).toBe(false);
  });
  it("normalizes malformed manifests and blocks empty manifests before mutation", () => {
    for (const command of ["inspect", "status", "apply"] as const) {
      const x = setup();
      x.manifest.assets[0]!.checksum = "wrong";
      const result = command === "inspect" ? inspectProjectActivation(x)
        : command === "status" ? readProjectActivationStatus(x) : applyProjectActivation(x);
      expect(result).toMatchObject({
        schemaVersion: 1, command, ok: false, repo: { root: x.repo, toplevel: x.repo },
        runtime: null, init: null, activation: { installed: { state: "blocked" } },
        errors: [{ code: "runtime_failed" }],
      });
    }
    const x = setup();
    x.manifest.assets = [];
    const result = applyProjectActivation(x);
    expect(result).toMatchObject({
      ok: false, outcome: "blocked", instructions: [], runtime: null, init: null,
      errors: [{ code: "invalid_release_manifest" }],
    });
    expect(fs.existsSync(x.db)).toBe(false);
    expect(fs.existsSync(path.join(x.repo, "AGENTS.md"))).toBe(false);
  });
  it("binds DB identity to the main repo while writing instructions only to the current worktree", () => {
    const x = setup();
    const linked = path.join(path.dirname(x.repo), "linked");
    git(x.repo, "worktree", "add", "-b", "activation-linked", linked);
    const result = applyProjectActivation({ ...x, repoPath: linked });
    expect(result).toMatchObject({
      ok: true,
      repo: { root: x.repo, toplevel: linked, status: "canonical" },
    });
    expect(fs.existsSync(path.join(linked, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(linked, "CLAUDE.md"))).toBe(true);
    expect(fs.existsSync(path.join(x.repo, "AGENTS.md"))).toBe(false);
    const db = openDb(x.db);
    expect(db.prepare(`SELECT root_path root FROM repos`).get()).toEqual({ root: x.repo });
    db.close();
  });
  it("does not let a sibling worktree session prove the current checkout handshake", () => {
    const x = setup();
    applyProjectActivation(x);
    const linked = path.join(path.dirname(x.repo), "handshake-linked");
    git(x.repo, "worktree", "add", "-b", "handshake-linked", linked);
    applyProjectActivation({ ...x, repoPath: linked });
    const blockTime = new Date("2026-07-18T00:00:00.000Z");
    for (const file of ["AGENTS.md", "CLAUDE.md"]) fs.utimesSync(path.join(linked, file), blockTime, blockTime);
    const status = readProjectActivationStatus({ ...x, repoPath: linked });
    const repoId = status.runtime!.repo.id!;
    const db = openDb(x.db);
    addHostSession(db, repoId, x.repo, x.repo, "main-session", "2026-07-18T00:01:00.000Z");
    db.close();
    expect(readProjectActivationStatus({ ...x, repoPath: linked }).activation.connected.state).toBe("not_proven");
    const db2 = openDb(x.db);
    addHostSession(db2, repoId, x.repo, linked, "linked-session", "2026-07-18T00:02:00.000Z");
    db2.close();
    expect(readProjectActivationStatus({ ...x, repoPath: linked }).activation.connected.state).toBe("proven");
  });
  it("includes mode in the pre-rename TOCTOU probe", () => {
    const x = setup();
    const target = path.join(x.repo, "AGENTS.md");
    fs.writeFileSync(target, "agents");
    fs.writeFileSync(path.join(x.repo, "CLAUDE.md"), "claude");
    const result = applyProjectActivation({
      ...x,
      instructionFault: ({ phase }) => {
        if (phase === "before-runtime-init") fs.chmodSync(target, 0o600);
      },
    });
    expect(result).toMatchObject({
      ok: false, outcome: "partial", errors: [{ code: "instruction_commit_failed" }],
    });
    expect(fs.readFileSync(target, "utf8")).toBe("agents");
  });
});
