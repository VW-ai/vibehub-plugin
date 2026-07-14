import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  OperationDispatcher,
  DistillationService,
  openDb,
  readTask,
  readScopePatterns,
  upsertRepo,
  upsertTask,
  type Db,
} from "@vibehub/core";
import { createCapabilities } from "../src/capabilities.js";
import { createWorkbenchMcpServer, operationEnvelopeResult, WORKBENCH_MCP_TOOL_NAMES } from "../src/server.js";
import { openRuntimeContext } from "../src/runtime.js";

const NOW = "2026-07-12T10:00:00.000Z";
const toolText = (value: unknown): string =>
  (value as { content: Array<{ type: "text"; text: string }> }).content[0]!.text;

describe("local MCP deterministic capabilities", () => {
  let dir: string;
  let db: Db;
  let commit: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-mcp-"));
    const repo=path.join(dir,"repo");fs.mkdirSync(repo);execFileSync("git",["init","-q"],{cwd:repo});execFileSync("git",["config","user.name","Test"],{cwd:repo});execFileSync("git",["config","user.email","test@example.com"],{cwd:repo});fs.writeFileSync(path.join(repo,"README.md"),"test\n");execFileSync("git",["add","README.md"],{cwd:repo});execFileSync("git",["commit","-qm","initial"],{cwd:repo});commit=execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim();
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, repo, null, "main", NOW);
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

  it("resolves task capabilities only inside the owning repository", () => {
    const other = upsertRepo(db, path.join(dir, "other"), null, "main", NOW);
    const owner = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    const nonOwner = createCapabilities({ db, repoId: other.id, taskId: "branch:feat/mcp", now: () => NOW });

    expect(owner.selfReport({ status: "owned" })).toMatchObject({ status: "owned" });
    expect(() => nonOwner.selfReport({ status: "not-owned" })).toThrow(/missing task/);
  });

  it("advertises only honest tools and canonical mutation adapters have successful fixtures", () => {
    const server=createWorkbenchMcpServer({db,repoId:1,taskId:"branch:feat/mcp",actor:"mcp-test",now:()=>NOW});
    const registered=(server as unknown as {_registeredTools:Record<string,{description?:string}>})._registeredTools;
    expect(Object.keys(registered)).toEqual([...WORKBENCH_MCP_TOOL_NAMES]);
    expect(registered).not.toHaveProperty("kb_record");
    expect(registered).not.toHaveProperty("kb_apply_distillation");
    expect(Object.values(registered).map((tool)=>tool.description??"").join("\n")).not.toMatch(/compatibility name|unsupported_operation/i);
    const ids=["mcp-kb-write","mcp-distill-start"];
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", actor:"mcp-test", requestId:()=>ids.shift()!, now: () => NOW });
    const kb=api.dispatchKnowledge("kb.draft.apply",{idempotencyKey:"mcp-write",specs:[{id:"mcp-contract",type:"contract",summary:"MCP persists through the canonical dispatcher",evidence:[{sourceType:"test",sourceRef:"mcp",evidenceRef:"fixture"}]}]});
    const distill=api.dispatchOperation("distill.run.start",{runId:"mcp-success",mode:"cold",baseCommit:commit,skillHash:"s",configHash:"c"});
    expect(kb).toMatchObject({ok:true});
    expect(distill).toMatchObject({ok:true,data:{state:"collecting"}});
    expect(operationEnvelopeResult(kb).isError).toBe(false);
  });

  it("canonical MCP reads preserve the exact dispatcher envelope", () => {
    const api=createCapabilities({db,repoId:1,taskId:"branch:feat/mcp",actor:"mcp-test",requestId:()=>"r-read",now:()=>NOW});
    expect(api.dispatchKnowledge("kb.spec.search",{query:"MCP"})).toEqual(new OperationDispatcher(db).dispatch("kb.spec.search",{repoId:1,actor:"mcp-test",taskId:"branch:feat/mcp",requestId:"r-read",now:NOW},{query:"MCP"}));
  });

  it("assigns a unique request id to each invocation when no id source is provided", () => {
    const api=createCapabilities({db,repoId:1,taskId:"branch:feat/mcp",actor:"mcp-test",now:()=>NOW});
    const status=api.dispatchKnowledge("kb.status",{});
    const search=api.dispatchKnowledge("kb.spec.search",{});
    expect(status).toMatchObject({ok:true});
    expect(search).toMatchObject({ok:true});
    if(!status.ok||!search.ok)throw new Error("expected successful capability envelopes");
    expect(status.meta.requestId).not.toBe(search.meta.requestId);
    const explicit=api.dispatchKnowledge("kb.status",{},"explicit-replay");
    expect(api.dispatchKnowledge("kb.status",{},"explicit-replay")).toEqual(explicit);
  });

  it("separates MCP transport correlation from explicit logical replay ids", async () => {
    const connectSession = async (name: string) => {
      const server = createWorkbenchMcpServer({
        db, repoId: 1, taskId: "branch:feat/mcp", actor: "mcp-test", now: () => NOW,
      });
      const client = new Client({ name, version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return { client, server };
    };
    const first = await connectSession("first-session");
    const second = await connectSession("second-session");
    try {
      const retrieve = await first.client.callTool({
        name: "kb_retrieve", arguments: { query: "nothing-yet" },
      });
      const status = await second.client.callTool({
        name: "kb_operation", arguments: { operation: "kb.status" },
      });
      expect(retrieve.isError).not.toBe(true);
      expect(status.isError).not.toBe(true);
      const retrieveEnvelope = JSON.parse(toolText(retrieve));
      const statusEnvelope = JSON.parse(toolText(status));
      expect(retrieveEnvelope.meta.requestId).toMatch(/^mcp-[0-9a-f-]{36}$/);
      expect(statusEnvelope.meta.requestId).toMatch(/^mcp-[0-9a-f-]{36}$/);
      expect(statusEnvelope.meta.requestId).not.toBe(retrieveEnvelope.meta.requestId);

      const explicitArguments = { operation: "kb.status", requestId: "logical-replay-1" };
      const explicit = await first.client.callTool({ name: "kb_operation", arguments: explicitArguments });
      const replay = await second.client.callTool({ name: "kb_operation", arguments: explicitArguments });
      expect(replay).toEqual(explicit);
      expect(JSON.parse(toolText(explicit))).toMatchObject({
        ok: true, meta: { requestId: "logical-replay-1" },
      });

      const explicitDistill = await first.client.callTool({
        name: "distill_operation",
        arguments: {
          operation: "distill.run.start", requestId: "logical-distill-1",
          input: { runId: "registered-handler-run", mode: "cold", baseCommit: commit, skillHash: "s", configHash: "c" },
        },
      });
      expect(JSON.parse(toolText(explicitDistill))).toMatchObject({
        ok: true, meta: { requestId: "logical-distill-1" },
      });

      const conflict = await second.client.callTool({
        name: "kb_operation",
        arguments: { ...explicitArguments, input: { unexpected: "changed" } },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.parse(toolText(conflict))).toMatchObject({
        ok: false, error: { code: "idempotency_conflict" },
      });

      const invalid = await first.client.callTool({
        name: "distill_operation",
        arguments: { operation: "distill.run.status", requestId: " padded ", input: { runId: "x" } },
      });
      expect(invalid.isError).toBe(true);
      expect(toolText(invalid)).toMatch(/requestId/i);
    } finally {
      await Promise.all([first.client.close(), second.client.close(), first.server.close(), second.server.close()]);
    }
  });

  it("distillation MCP is byte-semantic parity with the shared dispatcher",()=>{
    const ids=["distill-status","distill-candidates"];const api=createCapabilities({db,repoId:1,taskId:"branch:feat/mcp",actor:"mcp-test",requestId:()=>ids.shift()!,now:()=>NOW});
    const input={runId:"mcp-run",mode:"cold",baseCommit:commit,skillHash:"s",configHash:"c"};
    const expected=new OperationDispatcher(db).dispatch("distill.run.start",{repoId:1,actor:"mcp-test",taskId:"branch:feat/mcp",requestId:"distill-start",now:NOW},input);
    expect(expected).toMatchObject({ok:true});
    expect(api.dispatchOperation("distill.run.status",{runId:"mcp-run"})).toEqual(new OperationDispatcher(db).dispatch("distill.run.status",{repoId:1,actor:"mcp-test",taskId:"branch:feat/mcp",requestId:"distill-status",now:NOW},{runId:"mcp-run"}));
    expect(api.dispatchOperation("distill.candidates.list",{runId:"mcp-run"})).toEqual(new OperationDispatcher(db).dispatch("distill.candidates.list",{repoId:1,actor:"mcp-test",taskId:"branch:feat/mcp",requestId:"distill-candidates",now:NOW},{runId:"mcp-run"}));
  });
  it("routes selective retry and resolved baseCommit through MCP parity",()=>{const c={actor:"seed",taskId:"branch:feat/mcp",requestId:"seed",now:NOW},s=new DistillationService(db);s.start(1,{runId:"retry-mcp",mode:"cold",baseCommit:commit,skillHash:"s",configHash:"c"},c);s.putInventory(1,{runId:"retry-mcp",rows:[{path:"a.ts",classification:"included",contentHash:"h"}]},c);s.sealInventory(1,{runId:"retry-mcp"},c);s.planScopes(1,{runId:"retry-mcp",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["a.ts"]}]},c);const lease=s.claimScope(1,{runId:"retry-mcp",workerId:"w",leaseSeconds:60},c)!;s.failScope(1,{runId:"retry-mcp",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,reason:"lost"},c);s.reconcile(1,{runId:"retry-mcp"},c);const api=createCapabilities({db,repoId:1,taskId:"branch:feat/mcp",actor:"mcp-test",requestId:()=>"retry-mcp-1",now:()=>NOW}),input={runId:"retry-mcp",scopeId:"leaf",reason:"retry"};expect(api.dispatchOperation("distill.scopes.retry",input)).toEqual(new OperationDispatcher(db).dispatch("distill.scopes.retry",{repoId:1,actor:"mcp-test",taskId:"branch:feat/mcp",requestId:"retry-mcp-1",now:NOW},input));});

  it("self_report stores a one-line status and get_manual stays reference-only", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", now: () => NOW });
    expect(api.selfReport({ status: "MCP spine is green", done: "scope registry" })).toEqual({
      status: "MCP spine is green", done: "scope registry", reportedAt: NOW,
    });
    expect(api.getManual({ topic: "skills" }).text).toContain("skills own semantic workflow");
  });

  it("MCP dispatch is the same operation envelope and preserves actor/task requirements", () => {
    const api = createCapabilities({ db, repoId: 1, taskId: "branch:feat/mcp", actor: "mcp-test", requestId: () => "same-request", now: () => NOW });
    const direct = new OperationDispatcher(db).dispatch("kb.status", {
      repoId: 1, actor: "mcp-test", taskId: "branch:feat/mcp", requestId: "same-request", now: NOW,
    }, {});
    expect(api.dispatchKnowledge("kb.status", {})).toEqual(direct);
    expect(api.dispatchKnowledge("kb.spec.search", {})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(new OperationDispatcher(db).dispatch("kb.draft.apply", {
      repoId: 1, actor: "mcp-test", requestId: "missing-task", now: NOW,
    }, { idempotencyKey: "x", specs: [{id:"x",type:"context",summary:"x",evidence:[{sourceType:"test",sourceRef:"t",evidenceRef:"t"}]}] })).toMatchObject({ ok: false, error: { code: "task_required" } });
    expect(operationEnvelopeResult(direct).isError).toBe(false);
    expect(operationEnvelopeResult(api.dispatchKnowledge("kb.nope", {})).isError).toBe(true);
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
    expect(runtime.context.taskId).toMatch(/^task:[0-9a-f]+$/);
    expect(runtime.context.repoId).toBe(1);
    expect(readTask(runtime.context.db, runtime.context.taskId)?.startHeadSha).toMatch(/^[0-9a-f]{40}$/);
    runtime.close();
  });
});
