import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import crypto from "node:crypto";
import {Worker} from "node:worker_threads";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import {DistillationService,OperationDispatcher,openDb,upsertRepo,type Db} from "../src/index.js";
import {seedActiveMapping} from "./kb-fixtures.js";

const NOW="2026-07-13T12:00:00.000Z";
let COMMIT="";
const ctx=(requestId="r1")=>({repoId:1,actor:"agent",taskId:"task-1",requestId,now:NOW});
function createRepo(root:string){fs.mkdirSync(root,{recursive:true});execFileSync("git",["init","-q"],{cwd:root});execFileSync("git",["config","user.name","Test"],{cwd:root});execFileSync("git",["config","user.email","test@example.com"],{cwd:root});fs.writeFileSync(path.join(root,"README.md"),"test\n");execFileSync("git",["add","README.md"],{cwd:root});execFileSync("git",["commit","-qm","initial"],{cwd:root});return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();}
const contentHash=(value:string)=>crypto.createHash("sha256").update(value).digest("hex");
function commitChanges(repo:string,changes:Record<string,string|null>,message:string){for(const [relative,content] of Object.entries(changes)){const absolute=path.join(repo,relative);if(content===null)fs.rmSync(absolute,{force:true});else{fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,content);}}execFileSync("git",["add","-A"],{cwd:repo});execFileSync("git",["commit","-qm",message],{cwd:repo});return execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim();}
function pinFixtureBaseline(db:Db,baseCommit:string,features:Array<{id:string;name:string;parentId?:string;anchors?:Array<{file:string;symbol?:string}>}>){seedActiveMapping(db,1,features,NOW);const row=db.prepare(`SELECT a.version_id versionId,v.checksum FROM repo_active_mapping a JOIN mapping_versions v ON v.repo_id=a.repo_id AND v.version_id=a.version_id WHERE a.repo_id=1`).get() as {versionId:string;checksum:string};db.prepare(`INSERT INTO distill_runs(repo_id,run_id,mode,base_commit,skill_hash,config_hash,state,inventory_sealed_at,created_at,updated_at,finalized_version_id,candidate_snapshot_checksum,reconciled_at) VALUES(1,'fixture-baseline','cold',?,'fixture','fixture','finalized',?,?,?,?,?,?)`).run(baseCommit,NOW,NOW,NOW,row.versionId,"fixture",NOW);db.prepare(`INSERT INTO distill_run_versions(repo_id,run_id,version_id,projection_checksum,candidate_checksum,created_at) VALUES(1,'fixture-baseline',?,?,?,?)`).run(row.versionId,row.checksum,"fixture",NOW);return row.versionId;}

describe("DistillationService",()=>{
  let dir:string,db:Db,s:DistillationService;
  beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-distill-"));const repo=path.join(dir,"repo");COMMIT=createRepo(repo);db=openDb(path.join(dir,"db.sqlite"));upsertRepo(db,repo,null,"main",NOW);seedActiveMapping(db,1,[{id:"old",name:"Old",anchors:[{file:"src/old.ts",symbol:"old"}]}],NOW);s=new DistillationService(db);});
  afterEach(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});

  function start(runId="run-1") { return s.start(1,{runId,mode:"cold",baseCommit:COMMIT,skillHash:"skill",configHash:"config"},ctx()); }
  function prepare(runId="run-1") {
    start(runId);
    s.putInventory(1,{runId,rows:[{path:"src/a.ts",classification:"included",contentHash:"hash-a"},{path:"README.md",classification:"excluded",reason:"non_regular_file"}]},ctx());
    s.sealInventory(1,{runId},ctx());
    s.planScopes(1,{runId,scopes:[{scopeId:"root",kind:"analysis",parentScopeId:null,files:[]},{scopeId:"leaf",kind:"leaf",parentScopeId:"root",files:["src/a.ts"]}]},ctx());
    const parent=s.claimScope(1,{runId,workerId:"w",leaseSeconds:60},ctx())!;
    s.completeScope(1,{runId,scopeId:parent.scopeId,leaseToken:parent.leaseToken,generation:parent.generation,coveredFiles:[]},ctx());
    const claim=s.claimScope(1,{runId,workerId:"w",leaseSeconds:60},ctx())!;
    return {runId,claim};
  }

  it("validates every direct public boundary before DB or Git side effects",()=>{
    const invalid=(run:()=>unknown)=>{try{run();throw new Error("expected validation_error");}catch(error){expect(error).toMatchObject({code:"validation_error"});}};
    const validStart={runId:"direct",mode:"cold" as const,baseCommit:COMMIT,skillHash:"skill",configHash:"config"};
    invalid(()=>s.start(1,{...validStart,runId:" "},ctx()));
    invalid(()=>s.start(1,{...validStart,skillHash:" "},ctx()));
    invalid(()=>s.start(1,validStart,{...ctx(),actor:" "}));
    invalid(()=>s.start(1,validStart,{...ctx(),requestId:" "}));
    invalid(()=>s.start(1,validStart,{...ctx(),now:"not-a-date"}));
    invalid(()=>s.start(0,validStart,{...ctx(),repoId:1} as any));
    expect((db.prepare(`SELECT COUNT(*) n FROM distill_runs`).get() as {n:number}).n).toBe(0);
    invalid(()=>s.status(1," "));
    invalid(()=>s.getCandidate(1,{runId:" ",kind:"feature",naturalId:" "}));
    invalid(()=>s.planScopes(1,{runId:" ",scopes:[]},ctx()));
    invalid(()=>s.claimScope(1,{runId:"run",workerId:" ",leaseSeconds:60},ctx()));
    invalid(()=>s.putCandidate(1,{runId:"run",kind:"feature",naturalId:" ",sourceScopeId:"scope",leaseToken:"lease",generation:1,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx()));
    const oversizedEvidence=Array.from({length:20},(_,i)=>({sourceRef:`src/${i}.ts`,exactQuote:"x".repeat(20_000)}));
    invalid(()=>s.completeScope(1,{runId:"run",scopeId:"scope",leaseToken:"lease",generation:1,coveredFiles:[],unresolvedFiles:Array.from({length:3},(_,i)=>({path:`src/${i}.ts`,reason:"unresolved",evidence:oversizedEvidence}))},ctx()));
    invalid(()=>s.activate(1,{targetVersionId:" ",expectedCurrentVersion:null,reason:"activate"},ctx()));
    invalid(()=>s.rollback(1,{targetVersionId:"version",expectedCurrentVersion:null,reason:" "},ctx()));
    expect((db.prepare(`SELECT COUNT(*) n FROM distill_runs`).get() as {n:number}).n).toBe(0);
  });

  it("enforces the exact guarded run state machine and terminal abort",()=>{
    start();
    expect(s.status(1,"run-1").state).toBe("collecting");
    expect(()=>db.prepare(`UPDATE distill_runs SET state='validated' WHERE repo_id=1 AND run_id='run-1'`).run()).toThrow(/invalid distillation run state transition/);
    expect(()=>s.validate(1,{runId:"run-1"},ctx())).toThrow(/invalid_state_transition/);
    s.abort(1,{runId:"run-1",reason:"stop"},ctx());
    expect(s.status(1,"run-1").state).toBe("aborted");
    expect(()=>db.prepare(`UPDATE distill_runs SET state='running' WHERE repo_id=1 AND run_id='run-1'`).run()).toThrow(/invalid distillation run state transition/);
    expect(()=>s.putInventory(1,{runId:"run-1",rows:[{path:"a",classification:"included",contentHash:"hash-a"}]},ctx())).toThrow(/invalid_state_transition/);
  });

  it("seals immutable inventory and requires an exact one-leaf ownership partition",()=>{
    start();
    expect(()=>s.putInventory(1,{runId:"run-1",rows:[{path:"./a.ts",classification:"included",contentHash:"hash-a"}]},ctx())).toThrow(/validation_error/);
    s.putInventory(1,{runId:"run-1",rows:[{path:"a.ts",classification:"included",contentHash:"hash-a"},{path:"vendor/x",classification:"excluded",reason:"generated_or_dependency"}]},ctx());
    s.sealInventory(1,{runId:"run-1"},ctx());
    expect(()=>s.putInventory(1,{runId:"run-1",rows:[{path:"b.ts",classification:"included",contentHash:"hash-b"}]},ctx())).toThrow(/invalid_state_transition/);
    expect(()=>s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"x",kind:"leaf",parentScopeId:null,files:[]}]},ctx())).toThrow(/scope_file_partition/);
    s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"x",kind:"leaf",parentScopeId:null,files:["a.ts"]}]},ctx());
    expect(s.getInventory(1,"run-1")).toMatchObject({sealed:true,included:1,excluded:1});
  });

  it("persists honest file-level unresolved dispositions through reviewed finalize and activation",()=>{
    start();
    s.putInventory(1,{runId:"run-1",rows:[{path:"src/known.ts",classification:"included",contentHash:"known"},{path:"config/tool.json",classification:"included",contentHash:"config"}]},ctx());
    s.sealInventory(1,{runId:"run-1"},ctx());
    s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/known.ts","config/tool.json"]}]},ctx());
    const lease=s.claimScope(1,{runId:"run-1",workerId:"w",leaseSeconds:60},ctx())!;
    s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"known",sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,payload:{name:"Known"},evidence:[{sourceRef:"src/known.ts",contentHash:"known"}]},ctx());
    s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"known-anchor",sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,payload:{featureId:"known",file:"src/known.ts",contentHash:"known"},evidence:[{sourceRef:"src/known.ts",contentHash:"known"}]},ctx("anchor"));
    expect(()=>s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["src/known.ts"],unresolvedFiles:[{path:"src/known.ts",reason:"overlap"}]},ctx())).toThrow(/scope_file_partition/);
    expect(()=>s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["src/known.ts"],unresolvedFiles:[{path:"other.ts",reason:"unowned"}]},ctx())).toThrow(/scope_file_partition/);
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["src/known.ts"],unresolvedFiles:[{path:"config/tool.json",reason:"supporting configuration has no honest feature placement",evidence:[{sourceRef:"config/tool.json",contentHash:"config"}]}]},ctx());
    expect(JSON.parse((db.prepare(`SELECT result_summary summary FROM distill_scopes WHERE repo_id=1 AND run_id='run-1' AND scope_id='leaf'`).get() as {summary:string}).summary)).toEqual({coveredFiles:["src/known.ts"],unresolvedFiles:[{path:"config/tool.json",reason:"supporting configuration has no honest feature placement"}]});
    const reconciled=s.reconcile(1,{runId:"run-1"},ctx());
    expect(reconciled.accounting).toEqual({inventory:2,excluded:0,covered:1,unresolved:1});
    expect(reconciled.unresolved).toEqual(["config/tool.json"]);
    expect(reconciled.findings).toEqual(expect.arrayContaining([expect.objectContaining({severity:"review",code:"explicit_unresolved",subject:"config/tool.json"})]));
    expect(reconciled.findings.some((f:any)=>f.severity==="hard"||f.severity==="retryable")).toBe(false);
    expect(s.status(1,"run-1").unresolvedDispositions).toEqual([expect.objectContaining({path:"config/tool.json",scopeId:"leaf",reason:"supporting configuration has no honest feature placement"})]);
    s.validate(1,{runId:"run-1"},ctx());const finalized=s.finalize(1,{runId:"run-1"},ctx());
    expect(s.getVersion(1,finalized.versionId)).toMatchObject({unresolved:[{path:"config/tool.json",scopeId:"leaf",reason:"supporting configuration has no honest feature placement"}]});
    const old=(db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId;
    s.activate(1,{targetVersionId:finalized.versionId,expectedCurrentVersion:old,reason:"reviewed degraded mapping"},ctx("activate"));
    expect(()=>db.prepare(`UPDATE distill_scope_dispositions SET reason='changed'`).run()).toThrow(/immutable/);
    expect(()=>db.prepare(`DELETE FROM distill_scope_dispositions`).run()).toThrow(/immutable/);
  });

  it("enforces the closed mechanical exclusion taxonomy and incremental reason consistency",()=>{
    start();
    expect(()=>s.putInventory(1,{runId:"run-1",rows:[{path:"legacy.ts",classification:"excluded",reason:"unclassified_unreferenced"}]},ctx())).toThrow(/validation_error/);
    expect(()=>s.putInventory(1,{runId:"run-1",rows:[{path:"legacy.ts",classification:"excluded",reason:"incremental_deleted"}]},ctx())).toThrow(/validation_error/);
    expect(s.putInventory(1,{runId:"run-1",rows:[{path:"vendor/lib.js",classification:"excluded",reason:"generated_or_dependency"}]},ctx())).toMatchObject({excluded:1});
  });

  it("guards inventory row moves against both the old and new sealed parent",()=>{
    start("source");s.putInventory(1,{runId:"source",rows:[{path:"source.ts",classification:"included",contentHash:"s"}]},ctx());
    start("target");s.putInventory(1,{runId:"target",rows:[{path:"target.ts",classification:"included",contentHash:"t"}]},ctx());s.sealInventory(1,{runId:"target"},ctx());
    expect(()=>db.prepare(`UPDATE distill_inventory SET run_id='target' WHERE repo_id=1 AND run_id='source' AND path='source.ts'`).run()).toThrow(/sealed/);
  });

  it("verifies baseCommit is an existing commit in the stored repository",()=>{
    expect(()=>s.start(1,{runId:"fake",mode:"cold",baseCommit:"f".repeat(40),skillHash:"s",configHash:"c"},ctx())).toThrow(/base_commit_not_found/);
    expect(()=>s.start(1,{runId:"incremental-without-baseline",mode:"incremental",baseCommit:COMMIT,skillHash:"s",configHash:"c"},ctx())).toThrow(/unsupported_operation/);
    expect(start("real")).toMatchObject({baseCommit:COMMIT,state:"collecting"});
  });

  it("claims atomically, reclaims expired leases by generation, and rejects stale completion",()=>{
    const {claim}=prepare();
    expect(claim.generation).toBe(1);
    expect(s.claimScope(1,{runId:"run-1",workerId:"other",leaseSeconds:60},ctx())).toBeNull();
    db.prepare(`UPDATE distill_scopes SET lease_expires_at=? WHERE repo_id=1 AND run_id='run-1' AND scope_id='leaf'`).run("2026-07-13T11:00:00.000Z");
    const next=s.claimScope(1,{runId:"run-1",workerId:"other",leaseSeconds:60},ctx("r2"))!;
    expect(next.generation).toBe(2);
    expect(()=>s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:[]},ctx())).toThrow(/stale_lease/);
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:next.leaseToken,generation:2,coveredFiles:[]},ctx());
  });

  it("allows exactly one winner under genuine cross-connection claim overlap",async()=>{
    start();s.putInventory(1,{runId:"run-1",rows:[{path:"src/a.ts",classification:"included",contentHash:"hash-a"}]},ctx());s.sealInventory(1,{runId:"run-1"},ctx());s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/a.ts"]}]},ctx());db.close();
    const gate=new SharedArrayBuffer(4),workerUrl=new URL("./fixtures/distill-claim-worker.mjs",import.meta.url),dbPath=path.join(dir,"db.sqlite");
    const results=await Promise.all(["a","b"].map((workerId,i)=>new Promise<any>((resolve,reject)=>{const worker=new Worker(workerUrl,{workerData:{gate,dbPath,context:{...ctx(`worker-${i}`),now:NOW},input:{runId:"run-1",workerId,leaseSeconds:60}}});worker.once("message",resolve);worker.once("error",reject);}))) as Array<{ok:boolean;data:unknown}>;
    expect(results.filter(x=>x.ok&&x.data!==null)).toHaveLength(1);expect(results.filter(x=>x.ok&&x.data===null)).toHaveLength(1);db=openDb(dbPath);s=new DistillationService(db);
  });

  it("replays one claim receipt under genuine cross-connection duplicate delivery",async()=>{start();s.putInventory(1,{runId:"run-1",rows:[{path:"src/a.ts",classification:"included",contentHash:"hash-a"}]},ctx());s.sealInventory(1,{runId:"run-1"},ctx());s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/a.ts"]}]},ctx());db.close();const gate=new SharedArrayBuffer(4),workerUrl=new URL("./fixtures/distill-claim-worker.mjs",import.meta.url),dbPath=path.join(dir,"db.sqlite"),sameCtx={...ctx("same-claim"),now:NOW};const results=await Promise.all([0,1].map(()=>new Promise<any>((resolve,reject)=>{const worker=new Worker(workerUrl,{workerData:{gate,dbPath,context:sameCtx,input:{runId:"run-1",workerId:"same",leaseSeconds:60}}});worker.once("message",resolve);worker.once("error",reject);})));expect(results[0]).toEqual(results[1]);expect(results[0]).toMatchObject({ok:true,data:{scopeId:"leaf",generation:1}});db=openDb(dbPath);s=new DistillationService(db);});

  it("stores content-addressed immutable candidate corrections",()=>{
    const {claim}=prepare();
    expect(()=>s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"bad",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:" Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("bad-name"))).toThrow(/validation_error/);
    expect(()=>s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"bad",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts ",contentHash:"h"}]},ctx("bad-source"))).toThrow(/validation_error/);
    expect(()=>s.putCandidate(1,{runId:"run-1",kind:"spec",naturalId:"bad-spec",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{type:"context",summary:"Spec",priority:" high "},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("bad-priority"))).toThrow(/validation_error/);
    expect(()=>s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"bad-quote",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",exactQuote:"😀".repeat(20_001)}]},ctx("bad-quote"))).toThrow(/validation_error/);
    expect(s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"unicode",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Unicode",description:"😀".repeat(20_000)},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("unicode-description"))).toMatchObject({naturalId:"unicode"});
    expect(s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"unicode-anchor",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{featureId:"unicode",file:"src/a.ts",symbol:"😀".repeat(500),contentHash:"h"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("unicode-symbol"))).toMatchObject({naturalId:"unicode-anchor"});
    const one=s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());
    const replay=s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("r2"));
    expect(replay.revisionHash).toBe(one.revisionHash);
    const two=s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,supersedesHash:one.revisionHash,payload:{name:"Renamed"},evidence:[{sourceRef:"src/a.ts",contentHash:"h2"}]},ctx("r3"));
    expect(two.revisionHash).not.toBe(one.revisionHash);
    expect(()=>db.prepare(`UPDATE distill_candidate_revisions SET payload='{}' WHERE revision_hash=?`).run(one.revisionHash)).toThrow(/immutable/);
  });

  it("reopens only a completed scope implicated by findings and preserves truthful content replay provenance",()=>{
    const {claim}=prepare();
    const feature=s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx());
    const bad=s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"a",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{featureId:"f",file:"src/a.ts",contentHash:"wrong"},evidence:[{sourceRef:"src/a.ts",contentHash:"wrong"}]},ctx("bad-anchor"));
    s.putCandidate(1,{runId:"run-1",kind:"spec",naturalId:"s1",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{type:"decision",summary:"One"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("spec-one"));
    const badRelation=s.putCandidate(1,{runId:"run-1",kind:"relation",naturalId:"rel",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{fromKind:"spec",fromId:"s1",toKind:"spec",toId:"missing",type:"depends_on"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("bad-relation"));
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,coveredFiles:[]},ctx());
    expect(s.reconcile(1,{runId:"run-1"},ctx()).findings).toEqual(expect.arrayContaining([expect.objectContaining({code:"content_hash_mismatch",severity:"hard"}),expect.objectContaining({code:"invalid_endpoint",severity:"hard"}),expect.objectContaining({code:"unresolved_file",severity:"retryable"})]));
    expect(()=>s.correctScopes(1,{runId:"run-1",scopeIds:["root"],reason:"not implicated"},ctx())).toThrow(/scope_not_implicated/);
    expect(s.correctScopes(1,{runId:"run-1",scopeIds:["leaf"],reason:"repair anchor"},ctx())).toMatchObject({state:"running",reopened:[{scopeId:"leaf",generation:2}]});
    const next=s.claimScope(1,{runId:"run-1",workerId:"repair",leaseSeconds:60},ctx("claim-repair"))!;
    const replay=s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:next.leaseToken,generation:next.generation,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("same-feature"));
    expect(replay).toMatchObject({revisionHash:feature.revisionHash,acceptedScopeId:"leaf",acceptedLeaseToken:claim.leaseToken,acceptedLeaseGeneration:claim.generation});
    s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"a",sourceScopeId:"leaf",leaseToken:next.leaseToken,generation:next.generation,supersedesHash:bad.revisionHash,payload:{featureId:"f",file:"src/a.ts",contentHash:"hash-a"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("fixed-anchor"));
    s.putCandidate(1,{runId:"run-1",kind:"spec",naturalId:"s2",sourceScopeId:"leaf",leaseToken:next.leaseToken,generation:next.generation,payload:{type:"decision",summary:"Two"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("spec-two"));
    s.putCandidate(1,{runId:"run-1",kind:"relation",naturalId:"rel",sourceScopeId:"leaf",leaseToken:next.leaseToken,generation:next.generation,supersedesHash:badRelation.revisionHash,payload:{fromKind:"spec",fromId:"s1",toKind:"spec",toId:"s2",type:"depends_on"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash-a"}]},ctx("fixed-relation"));
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:next.leaseToken,generation:next.generation,coveredFiles:["src/a.ts"]},ctx());
    expect(s.reconcile(1,{runId:"run-1"},ctx()).findings).not.toEqual(expect.arrayContaining([expect.objectContaining({severity:"hard"})]));
    expect(s.validate(1,{runId:"run-1"},ctx()).state).toBe("validated");
    expect(db.prepare(`SELECT scope_id scopeId,from_generation fromGeneration,to_generation toGeneration,applied_at appliedAt FROM distill_scope_correction_audit`).get()).toEqual({scopeId:"leaf",fromGeneration:1,toGeneration:2,appliedAt:NOW});
  });

  it("rejects expired/reclaimed workers atomically and audits the accepted lease",()=>{
    const {claim}=prepare();db.prepare(`UPDATE distill_scopes SET lease_expires_at=? WHERE repo_id=1 AND run_id='run-1' AND scope_id='leaf'`).run("2026-07-13T11:00:00.000Z");
    const candidate={runId:"run-1",kind:"feature" as const,naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,payload:{name:"F"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]};
    expect(()=>s.putCandidate(1,candidate,ctx())).toThrow(/stale_lease/);expect(()=>s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:claim.generation,coveredFiles:[]},ctx())).toThrow(/stale_lease/);
    const fresh=s.claimScope(1,{runId:"run-1",workerId:"fresh",leaseSeconds:60},ctx())!;expect(fresh.generation).toBe(2);expect(()=>s.putCandidate(1,candidate,ctx())).toThrow(/stale_lease/);const accepted=s.putCandidate(1,{...candidate,leaseToken:fresh.leaseToken,generation:fresh.generation},ctx());expect(db.prepare(`SELECT accepted_lease_token token,accepted_lease_generation generation FROM distill_candidate_revisions WHERE revision_hash=?`).get(accepted.revisionHash)).toEqual({token:fresh.leaseToken,generation:2});
  });

  it("reconciles exact accounting and reports lost files, invalid endpoints, and collisions",()=>{
    const {claim}=prepare();
    s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"F"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:["src/a.ts"]},ctx());
    const result=s.reconcile(1,{runId:"run-1"},ctx());
    expect(result.accounting).toEqual({inventory:2,excluded:1,covered:0,unresolved:1});
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({code:"lost_file",severity:"hard"})]));
    expect(()=>s.validate(1,{runId:"run-1"},ctx())).toThrow(/hard_findings/);
  });

  it("persists hard endpoint and natural-ID collision findings without numeric semantic gates",()=>{
    const {claim}=prepare();
    s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"same",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"One"},evidence:[{sourceRef:"src/a.ts",contentHash:"1"}]},ctx());
    s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"same",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"Two"},evidence:[{sourceRef:"src/a.ts",contentHash:"2"}]},ctx("r2"));
    s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"missing:src/a.ts",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{featureId:"missing",file:"src/a.ts",contentHash:"3"},evidence:[{sourceRef:"src/a.ts",contentHash:"3"}]},ctx("r3"));
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:[]},ctx());
    expect(s.reconcile(1,{runId:"run-1"},ctx()).findings).toEqual(expect.arrayContaining([expect.objectContaining({code:"natural_id_collision",severity:"hard"}),expect.objectContaining({code:"invalid_endpoint",severity:"hard"})]));
  });

  it("finalizes immutable projections and CAS-activates or rolls back without losing the old pointer",()=>{
    const {claim}=prepare();
    s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"Feature",parentId:null,description:"desc",intent:"intent"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());
    s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"f:src/a.ts",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{featureId:"f",file:"src/a.ts",symbol:"run",contentHash:"hash-a"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("r2"));
    s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:["src/a.ts"]},ctx());
    expect(s.reconcile(1,{runId:"run-1"},ctx()).accounting).toEqual({inventory:2,excluded:1,covered:1,unresolved:0});
    s.validate(1,{runId:"run-1"},ctx());
    const finalized=s.finalize(1,{runId:"run-1"},ctx());
    expect(()=>db.prepare(`UPDATE mapping_version_features SET name='bad' WHERE repo_id=1 AND version_id=?`).run(finalized.versionId)).toThrow(/immutable/);
    expect(()=>db.prepare(`UPDATE distill_runs SET inventory_sealed_at=NULL WHERE repo_id=1 AND run_id='run-1'`).run()).toThrow(/immutable/);expect(()=>db.prepare(`UPDATE distill_inventory SET content_hash='bad' WHERE repo_id=1 AND run_id='run-1' AND path='src\/a.ts'`).run()).toThrow(/sealed/);expect(()=>db.prepare(`UPDATE distill_scopes SET worker_id='bad' WHERE repo_id=1 AND run_id='run-1' AND scope_id='leaf'`).run()).toThrow(/immutable/);expect(()=>db.prepare(`UPDATE distill_scope_files SET path='other' WHERE repo_id=1 AND run_id='run-1' AND path='src\/a.ts'`).run()).toThrow(/immutable/);expect(()=>db.prepare(`UPDATE distill_findings SET details='{}' WHERE repo_id=1 AND run_id='run-1'`).run()).toThrow(/immutable/);expect(()=>db.prepare(`UPDATE distill_run_versions SET candidate_checksum='bad' WHERE repo_id=1 AND run_id='run-1'`).run()).toThrow(/immutable/);
    db.prepare(`INSERT INTO mapping_versions(repo_id,version_id,state,source_kind,checksum,created_at,finalized_at) VALUES(1,'building-test','building','distillation','',?,NULL)`).run(NOW);db.prepare(`INSERT INTO distill_version_index(repo_id,version_id,ordinal,kind,natural_id,revision_hash) VALUES(1,'building-test',0,'feature','x','x')`).run();expect(()=>db.prepare(`UPDATE distill_version_index SET version_id=? WHERE repo_id=1 AND version_id='building-test'`).run(finalized.versionId)).toThrow(/immutable/);
    const old=(db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId;
    let casError:any;try{s.activate(1,{targetVersionId:finalized.versionId,expectedCurrentVersion:"stale",reason:"reviewed"},ctx());}catch(error){casError=error;}expect(casError).toMatchObject({code:"cas_conflict"});expect(casError.nextSafeActions).toEqual(expect.arrayContaining([expect.stringMatching(/baseline/i),expect.stringMatching(/version/i)]));
    expect((db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId).toBe(old);
    s.activate(1,{targetVersionId:finalized.versionId,expectedCurrentVersion:old,reason:"reviewed"},ctx());
    s.rollback(1,{targetVersionId:old,expectedCurrentVersion:finalized.versionId,reason:"rollback"},ctx("r3"));
    expect((db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId).toBe(old);
  });

  it("detects finalized candidate-index tampering before CAS and retains the active pointer",()=>{
    const {claim}=prepare();s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"F"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"a",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{featureId:"f",file:"src/a.ts",contentHash:"hash-a"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("r2"));s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:["src/a.ts"]},ctx());s.reconcile(1,{runId:"run-1"},ctx());s.validate(1,{runId:"run-1"},ctx());const finalized=s.finalize(1,{runId:"run-1"},ctx());const old=(db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId;
    expect(()=>db.prepare(`UPDATE distill_version_index SET natural_id='tampered' WHERE repo_id=1 AND version_id=? AND ordinal=0`).run(finalized.versionId)).toThrow(/immutable/);
    db.exec(`DROP TRIGGER finalized_distill_index_no_update`);db.prepare(`UPDATE distill_version_index SET natural_id='tampered' WHERE repo_id=1 AND version_id=? AND ordinal=0`).run(finalized.versionId);
    expect(()=>s.activate(1,{targetVersionId:finalized.versionId,expectedCurrentVersion:old,reason:"bad"},ctx())).toThrow(/checksum_mismatch/);expect((db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId).toBe(old);
  });

  it("persists interruption state and keeps candidates invisible to active KB search",()=>{
    const {claim}=prepare();
    s.putCandidate(1,{runId:"run-1",kind:"spec",naturalId:"candidate-only",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{type:"decision",summary:"candidate"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());
    const reopened=new DistillationService(db);
    expect(reopened.resume(1,{runId:"run-1"},ctx())).toMatchObject({state:"running",scopes:{leased:1}});
    expect(new OperationDispatcher(db).dispatch("kb.spec.search",ctx(),{query:"candidate",includeCandidates:true})).toMatchObject({ok:false,error:{code:"validation_error"}});
  });

  it("freezes the reconciled candidate snapshot and detects out-of-band TOCTOU corruption",()=>{
    const {claim}=prepare();s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"F"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx());s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"a",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{featureId:"f",file:"src/a.ts",contentHash:"hash-a"},evidence:[{sourceRef:"src/a.ts",contentHash:"h"}]},ctx("r2"));s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:["src/a.ts"]},ctx());const reconciled=s.reconcile(1,{runId:"run-1"},ctx());expect(reconciled.candidateSnapshotChecksum).toMatch(/^[0-9a-f]{64}$/);expect(()=>s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"late",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"Late"},evidence:[{sourceRef:"src/a.ts",contentHash:"late"}]},ctx("late"))).toThrow(/candidate_set_frozen/);
    db.exec(`DROP TRIGGER distill_candidate_identities_frozen_insert; DROP TRIGGER distill_candidate_revisions_frozen_insert`);db.prepare(`INSERT INTO distill_candidate_identities(repo_id,run_id,kind,natural_id,created_at) VALUES(1,'run-1','feature','tampered',?)`).run(NOW);db.prepare(`INSERT INTO distill_candidate_revisions(repo_id,run_id,kind,natural_id,revision_hash,source_scope_id,payload,evidence,producer,produced_at,accepted_lease_token,accepted_lease_generation) VALUES(1,'run-1','feature','tampered','tampered-hash','leaf','{"name":"T"}','[]','tamper',?,'x',1)`).run(NOW);expect(()=>s.validate(1,{runId:"run-1"},ctx())).toThrow(/candidate_snapshot_mismatch/);
  });

  it("retries failed scopes idempotently and resumes every checkpoint from SQLite",()=>{
    const {claim}=prepare();s.failScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,reason:"worker died"},ctx());s.reconcile(1,{runId:"run-1"},ctx());const dispatcher=new OperationDispatcher(db),retryCtx={...ctx("retry-1")};const one=dispatcher.dispatch("distill.scopes.retry",retryCtx,{runId:"run-1",scopeId:"leaf",reason:"selective retry"}),two=dispatcher.dispatch("distill.scopes.retry",retryCtx,{runId:"run-1",scopeId:"leaf",reason:"selective retry"});expect(one).toEqual(two);expect(one).toMatchObject({ok:true,data:{state:"pending",generation:2,retrySeq:1}});expect(dispatcher.dispatch("distill.scopes.retry",retryCtx,{runId:"run-1",scopeId:"leaf",reason:"different"})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});db.close();db=openDb(path.join(dir,"db.sqlite"));s=new DistillationService(db);expect(s.resume(1,{runId:"run-1"},ctx())).toMatchObject({state:"reconciling",candidateSnapshotChecksum:null,inventory:[{path:"README.md"},{path:"src/a.ts"}],scopeDetails:expect.arrayContaining([expect.objectContaining({scopeId:"leaf",state:"pending",generation:2})]),findingDetails:[]});
  });

  it("precomputes anchor add/remove diffs even when feature metadata is unchanged",()=>{
    start();s.putInventory(1,{runId:"run-1",rows:[{path:"src/new.ts",classification:"included",contentHash:"new-hash"}]},ctx());s.sealInventory(1,{runId:"run-1"},ctx());s.planScopes(1,{runId:"run-1",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/new.ts"]}]},ctx());const claim=s.claimScope(1,{runId:"run-1",workerId:"w",leaseSeconds:60},ctx())!;s.putCandidate(1,{runId:"run-1",kind:"feature",naturalId:"old",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{name:"Old"},evidence:[{sourceRef:"src/new.ts",contentHash:"new-hash"}]},ctx());s.putCandidate(1,{runId:"run-1",kind:"anchor",naturalId:"new-anchor",sourceScopeId:"leaf",leaseToken:claim.leaseToken,generation:1,payload:{featureId:"old",file:"src/new.ts",symbol:"new",contentHash:"new-hash"},evidence:[{sourceRef:"src/new.ts",contentHash:"new-hash"}]},ctx("r2"));s.completeScope(1,{runId:"run-1",scopeId:"leaf",leaseToken:claim.leaseToken,generation:1,coveredFiles:["src/new.ts"]},ctx());s.reconcile(1,{runId:"run-1"},ctx());s.validate(1,{runId:"run-1"},ctx());const finalized=s.finalize(1,{runId:"run-1"},ctx());expect(db.prepare(`SELECT subject_id subjectId,change_kind changeKind FROM distill_version_diffs WHERE repo_id=1 AND version_id=? AND subject_kind='anchor' ORDER BY change_kind`).all(finalized.versionId)).toEqual([{subjectId:"old:src/new.ts:new",changeKind:"added"},{subjectId:"old:src/old.ts:old",changeKind:"removed"}]);expect(db.prepare(`SELECT change_kind changeKind FROM distill_version_diffs WHERE repo_id=1 AND version_id=? AND subject_kind='feature' AND subject_id='old'`).get(finalized.versionId)).toEqual({changeKind:"matches"});
  });

  it("derives deletion pruning from sealed inventory even when the agent forgets remove candidates",()=>{
    const repo=path.join(dir,"repo"),base=commitChanges(repo,{"src/delete.ts":"delete\n","src/keep.ts":"keep\n"},"baseline");pinFixtureBaseline(db,base,[{id:"f",name:"Feature",anchors:[{file:"src/delete.ts",symbol:"delete"},{file:"src/keep.ts",symbol:"keep"}]}]);const target=commitChanges(repo,{"src/delete.ts":null},"delete");
    s.start(1,{runId:"inc-delete",mode:"incremental",baseCommit:target,skillHash:"s",configHash:"c"},ctx("start-delete"));s.putInventory(1,{runId:"inc-delete",rows:[{path:"README.md",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("test\n"),changeKind:"unchanged"},{path:"src/delete.ts",classification:"excluded",reason:"incremental_deleted",changeKind:"deleted"},{path:"src/keep.ts",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("keep\n"),changeKind:"unchanged"}]},ctx("inventory-delete"));s.sealInventory(1,{runId:"inc-delete"},ctx("seal-delete"));s.planScopes(1,{runId:"inc-delete",scopes:[{scopeId:"account",kind:"analysis",parentScopeId:null,files:[]}]},ctx("plan-delete"));const lease=s.claimScope(1,{runId:"inc-delete",workerId:"w",leaseSeconds:60},ctx("claim-delete"))!;s.completeScope(1,{runId:"inc-delete",scopeId:"account",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:[]},ctx("complete-delete"));s.reconcile(1,{runId:"inc-delete"},ctx("reconcile-delete"));s.validate(1,{runId:"inc-delete"},ctx("validate-delete"));const version=s.finalize(1,{runId:"inc-delete"},ctx("finalize-delete"));expect((s.getVersion(1,version.versionId) as any).anchors.map((a:any)=>a.file)).toEqual(["src/keep.ts"]);
  });

  it("reviews a carried active feature that loses every projected anchor after pruning",()=>{
    const repo=path.join(dir,"repo"),base=commitChanges(repo,{"src/only.ts":"only\n"},"baseline");pinFixtureBaseline(db,base,[{id:"orphaned",name:"Orphaned",anchors:[{file:"src/only.ts",symbol:"only"}]}]);const target=commitChanges(repo,{"src/only.ts":null},"delete only anchor");
    s.start(1,{runId:"inc-orphan",mode:"incremental",baseCommit:target,skillHash:"s",configHash:"c"},ctx("start-orphan"));
    s.putInventory(1,{runId:"inc-orphan",rows:[{path:"README.md",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("test\n"),changeKind:"unchanged"},{path:"src/only.ts",classification:"excluded",reason:"incremental_deleted",changeKind:"deleted"}]},ctx("inventory-orphan"));
    s.sealInventory(1,{runId:"inc-orphan"},ctx("seal-orphan"));s.planScopes(1,{runId:"inc-orphan",scopes:[{scopeId:"account",kind:"analysis",parentScopeId:null,files:[]}]},ctx("plan-orphan"));const lease=s.claimScope(1,{runId:"inc-orphan",workerId:"w",leaseSeconds:60},ctx("claim-orphan"))!;s.completeScope(1,{runId:"inc-orphan",scopeId:"account",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:[]},ctx("complete-orphan"));
    expect(s.reconcile(1,{runId:"inc-orphan"},ctx("reconcile-orphan")).findings).toEqual(expect.arrayContaining([expect.objectContaining({severity:"review",code:"active_feature_lost_all_anchors",subject:"orphaned"})]));s.validate(1,{runId:"inc-orphan"},ctx("validate-orphan"));const version=s.finalize(1,{runId:"inc-orphan"},ctx("finalize-orphan"));expect(s.getVersion(1,version.versionId).findings).toEqual(expect.arrayContaining([expect.objectContaining({severity:"review",code:"active_feature_lost_all_anchors",subject:"orphaned"})]));
  });

  it("prunes every old anchor on modified and renamed paths before applying new anchors",()=>{
    const repo=path.join(dir,"repo"),base=commitChanges(repo,{"src/multi.ts":"old\n","src/old.ts":"rename\n"},"baseline");pinFixtureBaseline(db,base,[{id:"f",name:"Feature",anchors:[{file:"src/multi.ts",symbol:"one"},{file:"src/multi.ts",symbol:"two"},{file:"src/old.ts",symbol:"old"}]}]);fs.renameSync(path.join(repo,"src/old.ts"),path.join(repo,"src/new.ts"));const target=commitChanges(repo,{"src/multi.ts":"new\n"},"modify and rename");
    s.start(1,{runId:"inc-change",mode:"incremental",baseCommit:target,skillHash:"s",configHash:"c"},ctx("start-change"));s.putInventory(1,{runId:"inc-change",rows:[{path:"README.md",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("test\n"),changeKind:"unchanged"},{path:"src/multi.ts",classification:"included",contentHash:contentHash("new\n"),changeKind:"modified"},{path:"src/new.ts",classification:"included",contentHash:contentHash("rename\n"),changeKind:"renamed",previousPath:"src/old.ts"}]},ctx("inventory-change"));s.sealInventory(1,{runId:"inc-change"},ctx("seal-change"));s.planScopes(1,{runId:"inc-change",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/multi.ts","src/new.ts"]}]},ctx("plan-change"));const lease=s.claimScope(1,{runId:"inc-change",workerId:"w",leaseSeconds:60},ctx("claim-change"))!;const common={runId:"inc-change",kind:"anchor" as const,sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,evidence:[{sourceRef:"src/multi.ts",contentHash:contentHash("new\n")}]};s.putCandidate(1,{...common,naturalId:"new-multi",payload:{featureId:"f",file:"src/multi.ts",symbol:"replacement",contentHash:contentHash("new\n")}},ctx("put-multi"));s.putCandidate(1,{...common,naturalId:"new-rename",payload:{featureId:"f",file:"src/new.ts",symbol:"new",contentHash:contentHash("rename\n")}},ctx("put-rename"));s.completeScope(1,{runId:"inc-change",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["src/multi.ts","src/new.ts"]},ctx("complete-change"));s.reconcile(1,{runId:"inc-change"},ctx("reconcile-change"));s.validate(1,{runId:"inc-change"},ctx("validate-change"));const version=s.finalize(1,{runId:"inc-change"},ctx("finalize-change"));expect((s.getVersion(1,version.versionId) as any).anchors.map((a:any)=>`${a.file}:${a.symbol}`)).toEqual(["src/multi.ts:replacement","src/new.ts:new"]);
  });

  it("rejects typo remove targets and removal of a parent feature with surviving children",()=>{
    const repo=path.join(dir,"repo"),base=commitChanges(repo,{"src/parent.ts":"parent\n"},"baseline");pinFixtureBaseline(db,base,[{id:"parent",name:"Parent",anchors:[{file:"src/parent.ts",symbol:"parent"}]},{id:"child",name:"Child",parentId:"parent"}]);const target=commitChanges(repo,{"src/parent.ts":"changed\n"},"target");s.start(1,{runId:"inc-remove",mode:"incremental",baseCommit:target,skillHash:"s",configHash:"c"},ctx("start-remove"));s.putInventory(1,{runId:"inc-remove",rows:[{path:"README.md",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("test\n"),changeKind:"unchanged"},{path:"src/parent.ts",classification:"included",contentHash:contentHash("changed\n"),changeKind:"modified"}]},ctx("inventory-remove"));s.sealInventory(1,{runId:"inc-remove"},ctx("seal-remove"));s.planScopes(1,{runId:"inc-remove",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["src/parent.ts"]}]},ctx("plan-remove"));const lease=s.claimScope(1,{runId:"inc-remove",workerId:"w",leaseSeconds:60},ctx("claim-remove"))!,common={runId:"inc-remove",sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,action:"remove" as const,evidence:[{sourceRef:"src/parent.ts",contentHash:contentHash("changed\n")} ]};let removeError:any;try{s.putCandidate(1,{...common,kind:"anchor",naturalId:"typo",payload:{featureId:"parent",file:"src/parent.ts",symbol:"typo",contentHash:"irrelevant"}},ctx("typo-remove"));}catch(error){removeError=error;}expect(removeError).toMatchObject({code:"remove_target_not_found"});expect(removeError.nextSafeActions).toEqual(expect.arrayContaining([expect.stringMatching(/baseline/i),expect.stringMatching(/version/i)]));s.putCandidate(1,{...common,kind:"feature",naturalId:"parent",payload:{name:"Parent"}},ctx("parent-remove"));s.completeScope(1,{runId:"inc-remove",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:[]},ctx("complete-remove"));expect(s.reconcile(1,{runId:"inc-remove"},ctx("reconcile-remove")).findings).toEqual(expect.arrayContaining([expect.objectContaining({severity:"hard",code:"feature_remove_has_children",subject:"parent"})]));
  });

  it("rejects an inventory whose sealed rows describe a different target tree",()=>{
    const repo=path.join(dir,"repo"),base=commitChanges(repo,{"src/a.ts":"a\n"},"baseline");pinFixtureBaseline(db,base,[{id:"f",name:"Feature",anchors:[{file:"src/a.ts",symbol:"a"}]}]);const target=commitChanges(repo,{"src/a.ts":"target\n"},"target");s.start(1,{runId:"inc-mismatch",mode:"incremental",baseCommit:target,skillHash:"s",configHash:"c"},ctx("start-mismatch"));s.putInventory(1,{runId:"inc-mismatch",rows:[{path:"README.md",classification:"excluded",reason:"incremental_unchanged",contentHash:contentHash("test\n"),changeKind:"unchanged"},{path:"src/a.ts",classification:"included",contentHash:contentHash("wrong\n"),changeKind:"modified"}]},ctx("inventory-mismatch"));expect(()=>s.sealInventory(1,{runId:"inc-mismatch"},ctx("seal-mismatch"))).toThrow(/inventory_target_mismatch/);
  });
});

describe("distillation dispatcher",()=>{
  it("exposes strict operation envelopes",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-distill-dispatch-")),repo=path.join(dir,"repo"),commit=createRepo(repo);const db=openDb(path.join(dir,"db.sqlite"));upsertRepo(db,repo,null,"main",NOW);const d=new OperationDispatcher(db);
    expect(d.dispatch("distill.run.start",ctx("dispatch-start"),{runId:"r",mode:"cold",baseCommit:commit,skillHash:"s",configHash:"c"})).toMatchObject({ok:true,data:{state:"collecting"}});
    expect(d.dispatch("distill.run.start",ctx("dispatch-invalid"),{runId:"bad",mode:"wrong"})).toMatchObject({ok:false,error:{code:"validation_error"}});
    expect(d.dispatch("distill.nope",ctx("dispatch-unsupported"),{})).toMatchObject({ok:false,error:{code:"unsupported_operation"}});
    db.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  it("rejects symbolic refs, hashless inventory, and malformed discriminated candidates",()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-distill-contract-")),db=openDb(path.join(dir,"db.sqlite"));upsertRepo(db,"/repo",null,"main",NOW);const d=new OperationDispatcher(db);expect(d.dispatch("distill.run.start",ctx("bad-ref"),{runId:"bad",mode:"cold",baseCommit:"HEAD",skillHash:"s",configHash:"c"})).toMatchObject({ok:false,error:{code:"validation_error"}});expect(d.dispatch("distill.inventory.put",ctx("bad-inventory"),{runId:"x",rows:[{path:"x",classification:"included"}]})).toMatchObject({ok:false,error:{code:"validation_error"}});expect(d.dispatch("distill.candidates.put",ctx("bad-spec"),{runId:"x",kind:"spec",naturalId:"s",sourceScopeId:"x",leaseToken:"t",generation:1,payload:{type:"made_up",summary:"x"},evidence:[{sourceRef:"x",contentHash:"h"}]})).toMatchObject({ok:false,error:{code:"validation_error"}});expect(d.dispatch("distill.candidates.put",ctx("bad-anchor"),{runId:"x",kind:"anchor",naturalId:"a",sourceScopeId:"x",leaseToken:"t",generation:1,payload:{featureId:"f",file:"../escape",contentHash:"h",lineStart:2,lineEnd:1},evidence:[{sourceRef:"x",contentHash:"h"}]})).toMatchObject({ok:false,error:{code:"validation_error"}});db.close();fs.rmSync(dir,{recursive:true,force:true});});
  it("replays claim/finalize/activate mutations and conflicts on request reuse",()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-distill-receipts-")),repo=path.join(dir,"repo"),commit=createRepo(repo),db=openDb(path.join(dir,"db.sqlite"));upsertRepo(db,repo,null,"main",NOW);seedActiveMapping(db,1,[{id:"old",name:"Old"}],NOW);const s=new DistillationService(db),d=new OperationDispatcher(db);s.start(1,{runId:"r",mode:"cold",baseCommit:commit,skillHash:"s",configHash:"c"},ctx());s.putInventory(1,{runId:"r",rows:[{path:"a.ts",classification:"included",contentHash:"h"}]},ctx());s.sealInventory(1,{runId:"r"},ctx());s.planScopes(1,{runId:"r",scopes:[{scopeId:"leaf",kind:"leaf",parentScopeId:null,files:["a.ts"]}]},ctx());const claimCtx=ctx("claim-once"),first=d.dispatch("distill.scopes.claim",claimCtx,{runId:"r",workerId:"w",leaseSeconds:60}),replay=d.dispatch("distill.scopes.claim",claimCtx,{runId:"r",workerId:"w",leaseSeconds:60});expect(replay).toEqual(first);expect(d.dispatch("distill.scopes.claim",claimCtx,{runId:"r",workerId:"other",leaseSeconds:60})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});const lease=(first as any).data;s.putCandidate(1,{runId:"r",kind:"feature",naturalId:"f",sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,payload:{name:"F"},evidence:[{sourceRef:"a.ts",contentHash:"h"}]},ctx());s.putCandidate(1,{runId:"r",kind:"anchor",naturalId:"a",sourceScopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,payload:{featureId:"f",file:"a.ts",contentHash:"h"},evidence:[{sourceRef:"a.ts",contentHash:"h"}]},ctx());s.completeScope(1,{runId:"r",scopeId:"leaf",leaseToken:lease.leaseToken,generation:lease.generation,coveredFiles:["a.ts"]},ctx());s.reconcile(1,{runId:"r"},ctx());s.validate(1,{runId:"r"},ctx());const finalizeCtx=ctx("finalize-once"),fin1=d.dispatch("distill.finalize",finalizeCtx,{runId:"r"}),fin2=d.dispatch("distill.finalize",finalizeCtx,{runId:"r"});expect(fin2).toEqual(fin1);const old=(db.prepare(`SELECT version_id versionId FROM repo_active_mapping WHERE repo_id=1`).get() as {versionId:string}).versionId,target=(fin1 as any).data.versionId,activateCtx=ctx("activate-once"),act1=d.dispatch("distill.activate",activateCtx,{targetVersionId:target,expectedCurrentVersion:old,reason:"reviewed"}),act2=d.dispatch("distill.activate",activateCtx,{targetVersionId:target,expectedCurrentVersion:old,reason:"reviewed"});expect(act2).toEqual(act1);expect((db.prepare(`SELECT COUNT(*) n FROM distill_mutation_receipts WHERE repo_id=1`).get() as {n:number}).n).toBe(3);db.close();fs.rmSync(dir,{recursive:true,force:true});});
});
