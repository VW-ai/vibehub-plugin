#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workbench = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(workbench, "packages/cli/dist/main.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-dogfood-"));
const home = path.join(root, "home");
const origin = path.join(root, "origin.git");
const repo = path.join(root, "repo");
const db = path.join(home, ".vibehub", "workbench.db");
fs.mkdirSync(home, { recursive: true });

const env = {
  ...process.env,
  HOME: home,
  VIBEHUB_DB: db,
  VIBEHUB_STATE_DIR: path.dirname(db),
  VIBEHUB_PLUGIN_ROOT: workbench,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "VibeHub Dogfood",
  GIT_AUTHOR_EMAIL: "dogfood@vibehub.local",
  GIT_COMMITTER_NAME: "VibeHub Dogfood",
  GIT_COMMITTER_EMAIL: "dogfood@vibehub.local",
};

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", env, ...options });
}

let cliCaptureSeq = 0;
function runCli(args, input) {
  const captureBase=path.join(root,`.cli-${cliCaptureSeq++}`);
  const stdoutFd=fs.openSync(`${captureBase}.out`,"w"),stderrFd=fs.openSync(`${captureBase}.err`,"w");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
    input,
    stdio:["pipe",stdoutFd,stderrFd],
  });
  fs.closeSync(stdoutFd);fs.closeSync(stderrFd);
  const stdout=fs.readFileSync(`${captureBase}.out`,"utf8"),stderr=fs.readFileSync(`${captureBase}.err`,"utf8");
  if (result.status !== 0) {
    throw new Error(`vibehub ${args.join(" ")} failed (${result.status}): ${stderr}`);
  }
  return stdout.trim();
}

try {
  run("git", ["init", "--bare", "-b", "main", origin], { cwd: root });
  run("git", ["clone", origin, repo], { cwd: root });
  fs.writeFileSync(path.join(repo, "README.md"), "# isolated dogfood\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "initial"], { cwd: repo });
  run("git", ["push", "-u", "origin", "main"], { cwd: repo });
  run("git", ["remote", "set-head", "origin", "main"], { cwd: repo });

  const firstInit = JSON.parse(runCli(["init", "--json"]));
  const secondInit = JSON.parse(runCli(["init", "--json"]));
  assert.equal(firstInit.ok, true);
  assert.equal(secondInit.ok, true);
  assert.equal(firstInit.repo.id, secondInit.repo.id);
  assert.ok(secondInit.managedAssets.every((asset) => asset.status === "healthy"));

  const hookPayload = {
    session_id: "dogfood-session",
    cwd: repo,
    hook_event_name: "SessionStart",
  };
  const startOutput = JSON.parse(runCli(["hook", "SessionStart"], JSON.stringify(hookPayload)));
  assert.match(startOutput.hookSpecificOutput.additionalContext, /register_scope/);

  const mcp = await import("../packages/mcp/dist/index.js");
  const runtime = mcp.openRuntimeContext(repo, db, () => "2026-07-13T00:00:00.000Z");
  let recorded;
  let retrieved;
  let distillation;
  try {
    const api = mcp.createCapabilities(runtime.context);
    assert.deepEqual(api.registerScope({ status: "dogfood", write: [{ glob: "README.md" }] }), { patterns: 1 });
    recorded = api.dispatchKnowledge("kb.draft.apply", { idempotencyKey: "dogfood-record", specs: [{
      id: "context-dogfood", type: "context", summary: "Deterministic local dogfood fact",
      evidence: [{ sourceType: "dogfood", sourceRef: "dogfood:task", evidenceRef: "dogfood:task" }],
    }] }, "dogfood-kb-draft-apply");
    assert.equal(recorded.ok, true, JSON.stringify(recorded));
    // Newly ingested canonical facts are drafts until explicit human promotion;
    // active-only retrieval must opt in to seeing this review candidate.
    retrieved = api.dispatchKnowledge("kb.spec.search", { query: "dogfood", limit: 5, includeDrafts: true }, "dogfood-kb-spec-search");
    assert.equal(retrieved.ok, true, JSON.stringify(retrieved));
    assert.ok(retrieved.data.items.some((fact) => fact.id === "context-dogfood"));
    let opSeq=0;const op=(operation,input)=>{const value=api.dispatchOperation(operation,input,`dogfood-distill-${++opSeq}`);assert.equal(value.ok,true,JSON.stringify(value));return value.data;};
    const active=op("kb.status",{}).activeMapping?.versionId ?? null;
    const baseCommit=run("git",["rev-parse","HEAD"],{cwd:repo}).trim();op("distill.run.start",{runId:"dogfood-distill",mode:"cold",baseCommit,skillHash:"dogfood-skill",configHash:"dogfood-config"});
    op("distill.inventory.put",{runId:"dogfood-distill",rows:[{path:"README.md",classification:"included",contentHash:"dogfood-readme"}]});
    op("distill.inventory.seal",{runId:"dogfood-distill"});
    op("distill.scopes.plan",{runId:"dogfood-distill",scopes:[{scopeId:"repo",parentScopeId:null,kind:"leaf",files:["README.md"]}]});
    const lease=op("distill.scopes.claim",{runId:"dogfood-distill",workerId:"dogfood",leaseSeconds:60});
    op("distill.candidates.put",{runId:"dogfood-distill",kind:"feature",naturalId:"dogfood",sourceScopeId:"repo",leaseToken:lease.leaseToken,generation:lease.generation,payload:{name:"Dogfood"},evidence:[{sourceRef:"README.md",contentHash:"dogfood-readme"}]});
    op("distill.candidates.put",{runId:"dogfood-distill",kind:"anchor",naturalId:"dogfood:README.md",sourceScopeId:"repo",leaseToken:lease.leaseToken,generation:lease.generation,payload:{featureId:"dogfood",file:"README.md",contentHash:"dogfood-readme"},evidence:[{sourceRef:"README.md",contentHash:"dogfood-readme"}]});
    op("distill.scopes.complete",{runId:"dogfood-distill",scopeId:"repo",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["README.md"]});
    const reconciled=op("distill.reconcile",{runId:"dogfood-distill"});assert.deepEqual(reconciled.accounting,{inventory:1,excluded:0,covered:1,unresolved:0});
    op("distill.validate",{runId:"dogfood-distill"});const finalized=op("distill.finalize",{runId:"dogfood-distill"});op("distill.activate",{targetVersionId:finalized.versionId,expectedCurrentVersion:active,reason:"dogfood reviewed activation"});distillation={versionId:finalized.versionId,covered:reconciled.accounting.covered};
  } finally {
    runtime.close();
  }

  JSON.parse(runCli(["team", "sync", "--json"]));
  const snapshot = JSON.parse(runCli(["snapshot"]));
  assert.equal(snapshot.repo.defaultBranch, "main");

  const core = await import("../packages/core/dist/index.js");
  const appTransport = await import("../app/dist-bridge/bridge-dogfood.js");
  const service = new core.RuntimeService({ dbPath: db });
  const repoRef = core.resolveWorkbenchRepoRef(repo, "dogfood");
  const transportFetch = async (_input, init) => {
    try {
      const envelope = JSON.parse(String(init?.body ?? ""));
      const result = appTransport.dispatchWorkbenchEnvelope(envelope, repoRef, service);
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ status: "internal_error", message: String(error) }), { status: 200 });
    }
  };
  const appBridge = appTransport.createWorkbenchBridge(
    { endpoint: "http://127.0.0.1/__vibehub/workbench", repo: repoRef },
    transportFetch,
  );
  const bridgeRead = await appBridge.getSnapshot(repoRef);
  assert.equal(bridgeRead.status, "ok");
  assert.throws(
    () => appTransport.dispatchWorkbenchEnvelope(
      { method: "getTaskPanel", request: repoRef }, repoRef, service,
    ),
    /invalid method-specific bridge request/,
  );

  const taskId = "branch:main";
  const intervention = service.applyIntervention(repoRef, "dogfood-injection", {
    kind: "inject",
    taskId,
    text: "dogfood delivery",
    contextLocus: "Task panel",
  });
  assert.equal(intervention.status, "ok");
  const stopOutput = JSON.parse(runCli(
    ["hook", "Stop"],
    JSON.stringify({ ...hookPayload, hook_event_name: "Stop", last_assistant_message: "done" }),
  ));
  assert.equal(stopOutput.decision, "block");
  assert.match(stopOutput.reason, /dogfood delivery/);

  const doctor = JSON.parse(runCli(["doctor", "--json"]));
  assert.equal(doctor.healthy, true);

  console.log(JSON.stringify({
    ok: true,
    isolatedRoot: root,
    init: { first: firstInit.ok, second: secondInit.ok, repoId: firstInit.repo.id },
    scopePatterns: 1,
    recordedSpec: recorded.data.created[0],
    retrievedSpecs: retrieved.data.length,
    distillation,
    snapshotTasks: snapshot.tasks.length,
    appBridgeStatus: bridgeRead.status,
    stopDelivery: stopOutput.decision,
    doctor: doctor.healthy,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
