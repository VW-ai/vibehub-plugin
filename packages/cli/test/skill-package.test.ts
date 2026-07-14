import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { openDb, OperationDispatcher, operationAcceptanceConstructManifest, operationInputSchemas, upsertRepo } from "@vibehub/core";

const cliRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const workbench=path.resolve(cliRoot,"../..");
const skills=path.join(workbench,"skills");
const entry=["vibehub-ingest","vibehub-query","vibehub-distill","vibehub-update","vibehub-review"];

function files(root:string):string[]{return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(root,e.name)):[path.join(root,e.name)]);}

describe("production skill package",()=>{
  it("contains valid progressive entrypoints and resolvable resources",()=>{
    const validation=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--package",skills],{encoding:"utf8"});
    expect(validation.status,validation.stdout+validation.stderr).toBe(0);
    for(const name of entry){
      const text=fs.readFileSync(path.join(skills,name,"SKILL.md"),"utf8");
      expect(text).toContain("## Prerequisites");
      expect(text.split("\n").length).toBeLessThan(500);
      expect(fs.existsSync(path.join(skills,name,"agents/openai.yaml"))).toBe(true);
    }
    const systemValidator=path.join(os.homedir(),".codex/skills/.system/skill-creator/scripts/quick_validate.py");
    if(fs.existsSync(systemValidator))for(const name of entry){const check=spawnSync("python3",[systemValidator,path.join(skills,name)],{encoding:"utf8"});expect(check.status,check.stdout+check.stderr).toBe(0);}
  });

  it("rejects a planted invalid skill package",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-invalid-skill-")),copy=path.join(temp,"skills");fs.cpSync(skills,copy,{recursive:true});
    const target=path.join(copy,"vibehub-query","SKILL.md");fs.writeFileSync(target,fs.readFileSync(target,"utf8").replace("name: vibehub-query","name: wrong-name"));
    const validation=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--package",copy],{encoding:"utf8"});
    expect(validation.status).toBe(2);expect(JSON.parse(validation.stdout)).toMatchObject({valid:false});
  });

  it("parses quoted colons and folded multiline YAML deterministically",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-yaml-skill-")),copy=path.join(temp,"skills");fs.cpSync(skills,copy,{recursive:true});
    const skillPath=path.join(copy,"vibehub-query","SKILL.md"),skill=fs.readFileSync(skillPath,"utf8");
    fs.writeFileSync(skillPath,skill.replace(/description: .*\n---/,"description: >\n  Use when: governed context, path lookup, or lineage is needed.\n  Retrieve facts without writing knowledge.\n---"));
    const metadataPath=path.join(copy,"vibehub-query","agents/openai.yaml"),metadata=fs.readFileSync(metadataPath,"utf8");fs.writeFileSync(metadataPath,metadata.replace('default_prompt: "','default_prompt: "Context: '));
    const validation=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--package",copy],{encoding:"utf8"});expect(validation.status,validation.stdout+validation.stderr).toBe(0);
  });

  it("keeps scripts and skills behind the dispatcher boundary",()=>{
    const text=files(skills).filter(x=>/\.(?:md|mjs)$/.test(x)).map(x=>fs.readFileSync(x,"utf8")).join("\n");
    expect(text).not.toMatch(/kb_apply_distillation/);
    expect(text).not.toMatch(/better-sqlite3|node:sqlite|from\s+["']sqlite/);
    expect(text).not.toMatch(/\b(?:SELECT|INSERT|UPDATE|DELETE)\s+(?:FROM|INTO|SET)\b/i);
    expect(text).not.toMatch(/(?:80%|5[-–]8 roots|10[-–]25 features|20[-–]30%)[^\n]*(?:must|required|gate|target)/i);
  });

  it("pins semantic guidance for relations, truth-layer reads, uncertainty, and exclusions",()=>{
    const read=(relative:string)=>fs.readFileSync(path.join(skills,relative),"utf8");
    const relations=read("_stdlib/relations.md");
    expect(relations).toContain("direct breach evidence");
    expect(relations).toContain("Adjacency is not dependency evidence");
    expect(relations).toContain("`relates_to` or no edge");

    const operations=read("_stdlib/db-operations.md");
    expect(operations).toContain("repository-wide request identity");
    expect(operations).toContain("requestId was reused with a different operation or canonical payload");
    expect(operations).toContain("`kb.anchors`");
    expect(operations).toContain("`distill.baseline.get`");
    expect(operations).toContain("`distill.version.get`");

    const query=read("vibehub-query/SKILL.md");
    expect(query).toContain("`kb.status` plus paginated `kb.spec.search`");
    expect(query).toContain("{items,count,total,limit,offset,hasMore,truncated}");
    expect(query).toContain("Never dump the KB");
    expect(query).toContain("App/snapshot");

    const distill=[read("vibehub-distill/SKILL.md"),read("vibehub-distill/references/feature-hypotheses.md")].join("\n");
    expect(distill).toContain("analyzable source uncertainty");
    expect(distill).toContain("explicitly unresolved");
    expect(distill).toContain("never mechanically excluded");
    expect(distill).toContain("no fake feature");

    const exclusions=[...read("_stdlib/quality-gates.md").matchAll(/`(generated_or_dependency|binary_file|oversize_file|non_regular_file|incremental_unchanged|incremental_deleted)`/g)].map(match=>match[1]);
    expect(exclusions).toEqual(["generated_or_dependency","binary_file","oversize_file","non_regular_file","incremental_unchanged","incremental_deleted"]);
    expect(read("_stdlib/provenance.md")).toContain("`symbol: null` is invalid");
  });

  it("keeps wrapper registries identical to dispatcher operation names",async()=>{
    const registry=await import(path.join(skills,"scripts/_dispatch.mjs")) as {KB:Set<string>;DISTILL:Set<string>};
    const expected=Object.keys(operationInputSchemas);
    expect([...registry.KB].map(x=>`kb.${x}`).sort()).toEqual(expected.filter(x=>x.startsWith("kb.")).sort());
    expect([...registry.DISTILL].map(x=>`distill.${x}`).sort()).toEqual(expected.filter(x=>x.startsWith("distill.")).sort());
  });

  it("keeps generated operation contracts and every refinement fixture executable through the packaged validator and dispatcher",async()=>{
    type Negative={case:string;value:unknown;refinementIds:string[]};type Contract={input:object;runtimeRefinements:unknown[];fixtures:{positive:unknown;negative:unknown;negativeCase:string;negatives:Negative[]}};
    const artifact=JSON.parse(fs.readFileSync(path.join(skills,"contracts/operation-contracts.json"),"utf8")) as {validationContract:string;acceptanceConstructs:Record<string,number>;refinementMatrix:Record<string,{operations:string[]}>;operations:Record<string,Contract>};
    expect(Object.keys(artifact.operations).sort()).toEqual(Object.keys(operationInputSchemas).sort());
    expect(artifact.validationContract).toContain("runtimeRefinements");
    expect(artifact.acceptanceConstructs).toEqual(operationAcceptanceConstructManifest);
    const {validateOperationContract}=await import(path.join(skills,"scripts/operation-contract-validator.mjs")) as {validateOperationContract:(contract:Contract,value:unknown)=>{valid:boolean;errors:unknown[]}};
    const ajv=new Ajv2020({allErrors:true,strict:false});
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-operation-contract-")),repo=path.join(temp,"repo");fs.mkdirSync(repo);expect(spawnSync("git",["init","-q",repo]).status).toBe(0);
    const db=openDb(path.join(temp,"db.sqlite"));const now="2026-01-01T00:00:00.000Z",row=upsertRepo(db,repo,"fixture/repo","main",now),dispatcher=new OperationDispatcher(db);
    for(const [operation,contract] of Object.entries(artifact.operations)){
      const schema=operationInputSchemas[operation as keyof typeof operationInputSchemas];
      const validateArtifact=ajv.compile(contract.input);
      expect(validateArtifact(contract.fixtures.positive),`${operation} artifact positive: ${JSON.stringify(validateArtifact.errors)}`).toBe(true);
      expect(validateOperationContract(contract,contract.fixtures.positive),`${operation} combined positive`).toMatchObject({valid:true});
      expect(schema.safeParse(contract.fixtures.positive).success,`${operation} positive fixture`).toBe(true);
      const positive=dispatcher.dispatch(operation,{repoId:row.id,actor:"fixture",taskId:"fixture-task",requestId:`positive-${operation}`,now},contract.fixtures.positive);
      if(!positive.ok)expect(positive.error.code,`${operation} positive dispatcher fixture`).not.toBe("validation_error");
      expect(contract.fixtures.negatives.length,`${operation} negatives`).toBeGreaterThan(0);
      for(const [index,fixture] of contract.fixtures.negatives.entries()){
        expect(fixture.case.length,`${operation} negative case`).toBeGreaterThan(5);
        expect(validateOperationContract(contract,fixture.value),`${operation}/${fixture.case} packaged artifact validator`).toMatchObject({valid:false});
        expect(schema.safeParse(fixture.value).success,`${operation}/${fixture.case} runtime schema`).toBe(false);
        const negative=dispatcher.dispatch(operation,{repoId:row.id,actor:"fixture",taskId:"fixture-task",requestId:`negative-${operation}-${index}`,now},fixture.value);
        expect(negative,`${operation}/${fixture.case} dispatcher`).toMatchObject({ok:false,error:{code:"validation_error"}});
      }
      for(const [id,matrix] of Object.entries(artifact.refinementMatrix))if(matrix.operations.includes(operation))expect(contract.fixtures.negatives.some(fixture=>fixture.refinementIds.includes(id)),`${operation}/${id} refinement coverage`).toBe(true);
    }
    const regressions=[
      ["distill.inventory.put","modified inventory row requires target contentHash"],
      ["kb.ingest.preview","lineEnd must not precede lineStart"],
      ["distill.candidates.put","relation candidate endpoints must differ"],
      ["kb.feature.get","top-level id rejects whitespace only"],
      ["kb.feature.get","top-level id measures raw padded length"],
      ["kb.feature.get","top-level id measures Unicode characters consistently"],
      ["kb.draft.apply","nested summary rejects leading whitespace"],
      ["kb.spec.search","array tag rejects whitespace only"],
    ] as const;
    for(const [operation,caseName] of regressions){const contract=artifact.operations[operation]!,fixture=contract.fixtures.negatives.find(x=>x.case===caseName)!;const run=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--operation",operation],{input:JSON.stringify(fixture.value),encoding:"utf8"});expect(run.status,`${operation}/${caseName}: ${run.stdout}`).toBe(2);}
    const unicodeId={id:"😀".repeat(200)},featureContract=artifact.operations["kb.feature.get"]!;expect(validateOperationContract(featureContract,unicodeId)).toMatchObject({valid:true});expect(operationInputSchemas["kb.feature.get"].safeParse(unicodeId).success).toBe(true);expect(dispatcher.dispatch("kb.feature.get",{repoId:row.id,actor:"fixture",requestId:"unicode-id",now},unicodeId)).toMatchObject({ok:false,error:{code:"not_found"}});
    const longInput={idempotencyKey:"unicode-long",specs:[{id:"unicode-long",type:"context",summary:"Unicode boundary",evidence:[{sourceType:"fixture",sourceRef:"fixture:unicode",exactQuote:"😀".repeat(20_000)}]}]},longContract=artifact.operations["kb.draft.apply"]!;expect(validateOperationContract(longContract,longInput)).toMatchObject({valid:true});expect(operationInputSchemas["kb.draft.apply"].safeParse(longInput).success).toBe(true);expect(dispatcher.dispatch("kb.draft.apply",{repoId:row.id,actor:"fixture",taskId:"fixture-task",requestId:"unicode-long",now},longInput)).toMatchObject({ok:true});
    expect(dispatcher.dispatch("kb.status",{repoId:row.id,actor:" ",requestId:"context-space",now},{})).toMatchObject({ok:false,error:{code:"actor_required"}});
    expect(dispatcher.dispatch("kb.status",{repoId:row.id,actor:"fixture",requestId:"context-date",now:"not-a-date"},{})).toMatchObject({ok:false,error:{code:"validation_error"}});
    db.close();
  });

  it("validates schemas and generates a deterministic inventory without HOME state",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-skill-")); const home=path.join(temp,"home"),repo=path.join(temp,"repo");
    fs.mkdirSync(home);fs.mkdirSync(repo);fs.writeFileSync(path.join(repo,"a.ts"),"export const a=1;\n");fs.writeFileSync(path.join(repo,"README.md"),"readme\n");fs.writeFileSync(path.join(repo,"é.ts"),"unicode\n");
    expect(spawnSync("git",["init","-q",repo]).status).toBe(0);
    const run=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","r1"],{encoding:"utf8",env:{...process.env,HOME:home}});
    expect(run.status,run.stdout+run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({runId:"r1",rows:[{path:"README.md",classification:"included"},{path:"a.ts",classification:"included"},{path:"é.ts",classification:"included"}]});
    expect(Object.keys(JSON.parse(run.stdout))).toEqual(["runId","rows"]);
    fs.symlinkSync("a.ts",path.join(repo,"linked.ts"));const nonRegular=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","non-regular"],{encoding:"utf8",env:{...process.env,HOME:home}});expect(JSON.parse(nonRegular.stdout).rows).toContainEqual({path:"linked.ts",classification:"excluded",reason:"non_regular_file"});fs.rmSync(path.join(repo,"linked.ts"));fs.rmSync(path.join(repo,"README.md"));fs.rmSync(path.join(repo,"é.ts"));
    spawnSync("git",["-C",repo,"config","user.name","Test"]);spawnSync("git",["-C",repo,"config","user.email","test@example.com"]);fs.writeFileSync(path.join(repo,"keep.ts"),"keep\n");fs.writeFileSync(path.join(repo,"delete.ts"),"delete\n");spawnSync("git",["-C",repo,"add","."]);spawnSync("git",["-C",repo,"commit","-qm","baseline"]);const base=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();fs.renameSync(path.join(repo,"a.ts"),path.join(repo,"b.ts"));fs.rmSync(path.join(repo,"delete.ts"));fs.writeFileSync(path.join(repo,"new.ts"),"new\n");const dirty=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","dirty","--base-commit",base],{encoding:"utf8",env:{...process.env,HOME:home}});expect(dirty.status).toBe(2);expect(JSON.parse(dirty.stdout)).toMatchObject({ok:false,error:{code:"inventory_error",message:"incremental inventory requires a clean HEAD or explicit --target-commit"}});spawnSync("git",["-C",repo,"add","-A"]);spawnSync("git",["-C",repo,"commit","-qm","target"]);const target=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();fs.writeFileSync(path.join(repo,"dirty.ts"),"ignored working tree\n");const incremental=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","r2","--base-commit",base,"--target-commit",target],{encoding:"utf8",env:{...process.env,HOME:home}});expect(incremental.status,incremental.stdout+incremental.stderr).toBe(0);expect(JSON.parse(incremental.stdout)).toMatchObject({runId:"r2",rows:[{path:"b.ts",classification:"included",changeKind:"renamed",previousPath:"a.ts"},{path:"delete.ts",classification:"excluded",changeKind:"deleted"},{path:"keep.ts",classification:"excluded",changeKind:"unchanged"},{path:"new.ts",classification:"included",changeKind:"added"}]});expect(Object.keys(JSON.parse(incremental.stdout))).toEqual(["runId","rows"]);expect(incremental.stderr).toBe("");const diagnosed=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","r2","--base-commit",base,"--target-commit",target,"--diagnostics"],{encoding:"utf8",env:{...process.env,HOME:home}});expect(JSON.parse(diagnosed.stdout)).toEqual(JSON.parse(incremental.stdout));expect(JSON.parse(diagnosed.stderr)).toEqual({baseCommit:base,targetCommit:target});const missing=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--base-commit"],{encoding:"utf8"});expect(missing.status).toBe(2);expect(JSON.parse(missing.stdout)).toMatchObject({ok:false,error:{code:"inventory_error",message:"missing value for --base-commit"}});
    for(const schema of fs.readdirSync(path.join(skills,"contracts")).filter(x=>x.endsWith(".json")))expect(()=>JSON.parse(fs.readFileSync(path.join(skills,"contracts",schema),"utf8"))).not.toThrow();
  });

  it("classifies incremental symlink and gitlink tree modes as non-regular inputs",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-skill-git-modes-")),repo=path.join(temp,"repo");
    fs.mkdirSync(repo);expect(spawnSync("git",["init","-q",repo]).status).toBe(0);
    spawnSync("git",["-C",repo,"config","user.name","Test"]);spawnSync("git",["-C",repo,"config","user.email","test@example.com"]);
    fs.writeFileSync(path.join(repo,"README.md"),"baseline\n");spawnSync("git",["-C",repo,"add","."]);spawnSync("git",["-C",repo,"commit","-qm","baseline"]);
    const base=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
    fs.symlinkSync("README.md",path.join(repo,"linked.md"));spawnSync("git",["-C",repo,"add","linked.md"]);
    expect(spawnSync("git",["-C",repo,"update-index","--add","--cacheinfo",`160000,${base},vendor/submodule`]).status).toBe(0);
    spawnSync("git",["-C",repo,"commit","-qm","add non-regular tree entries"]);
    const addedTarget=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
    fs.writeFileSync(path.join(repo,"regular.ts"),"regular\n");spawnSync("git",["-C",repo,"add","regular.ts"]);spawnSync("git",["-C",repo,"commit","-qm","leave tree entries unchanged"]);
    const unchangedTarget=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
    const run=(runId:string,from:string,target:string)=>spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id",runId,"--base-commit",from,"--target-commit",target],{encoding:"utf8"});
    const added=run("modes-added",base,addedTarget);expect(added.status,added.stdout+added.stderr).toBe(0);
    expect(JSON.parse(added.stdout).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({path:"linked.md",classification:"excluded",reason:"non_regular_file",changeKind:"added",contentHash:expect.any(String)}),
      expect.objectContaining({path:"vendor/submodule",classification:"excluded",reason:"non_regular_file",changeKind:"added",contentHash:expect.any(String)}),
    ]));
    const unchanged=run("modes-unchanged",addedTarget,unchangedTarget);expect(unchanged.status,unchanged.stdout+unchanged.stderr).toBe(0);
    expect(JSON.parse(unchanged.stdout).rows).toEqual(expect.arrayContaining([
      expect.objectContaining({path:"linked.md",classification:"excluded",reason:"non_regular_file",changeKind:"unchanged",contentHash:expect.any(String)}),
      expect.objectContaining({path:"vendor/submodule",classification:"excluded",reason:"non_regular_file",changeKind:"unchanged",contentHash:expect.any(String)}),
    ]));
    const validation=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--operation","distill.inventory.put"],{input:unchanged.stdout,encoding:"utf8"});
    expect(validation.status,validation.stdout+validation.stderr).toBe(0);
    expect(operationInputSchemas["distill.inventory.put"].safeParse(JSON.parse(unchanged.stdout)).success).toBe(true);
    fs.rmSync(temp,{recursive:true,force:true});
  });

  it("feeds raw mixed-case Unicode incremental inventory through put and strict seal unchanged",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-inventory-seal-")),repo=path.join(temp,"repo"),dbPath=path.join(temp,"db.sqlite"),now="2026-07-13T12:00:00.000Z";
    fs.mkdirSync(path.join(repo,"src"),{recursive:true});spawnSync("git",["init","-q",repo]);spawnSync("git",["-C",repo,"config","user.name","Test"]);spawnSync("git",["-C",repo,"config","user.email","test@example.com"]);
    fs.writeFileSync(path.join(repo,"README.md"),"readme\n");fs.writeFileSync(path.join(repo,"src/a.ts"),"old\n");fs.writeFileSync(path.join(repo,"é.ts"),"unicode\n");fs.symlinkSync("README.md",path.join(repo,"readme-link"));spawnSync("git",["-C",repo,"add","."]);spawnSync("git",["-C",repo,"commit","-qm","baseline"]);
    const base=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
    const db=openDb(dbPath),repoRow=upsertRepo(db,fs.realpathSync(repo),null,"main",now),version="inventory-baseline";
    db.prepare(`INSERT INTO mapping_versions(repo_id,version_id,state,source_kind,checksum,created_at) VALUES(?,?,'building','distillation','',?)`).run(repoRow.id,version,now);
    db.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at) VALUES(?,? ,?)`).run(repoRow.id,"root",now);
    db.prepare(`INSERT INTO mapping_version_features(repo_id,version_id,feature_id,name,lifecycle) VALUES(?,?,?,'Root','active')`).run(repoRow.id,version,"root");
    const checksum="fixture-checksum";db.prepare(`UPDATE mapping_versions SET state='finalized',checksum=?,finalized_at=? WHERE repo_id=? AND version_id=?`).run(checksum,now,repoRow.id,version);
    db.prepare(`INSERT INTO repo_active_mapping(repo_id,version_id,activated_at) VALUES(?,?,?)`).run(repoRow.id,version,now);
    db.prepare(`INSERT INTO distill_runs(repo_id,run_id,mode,base_commit,skill_hash,config_hash,state,inventory_sealed_at,created_at,updated_at,finalized_version_id,candidate_snapshot_checksum,reconciled_at) VALUES(?,?,'cold',?,'fixture','fixture','finalized',?,?,?,?,?,?)`).run(repoRow.id,"baseline-run",base,now,now,now,version,"fixture",now);
    db.prepare(`INSERT INTO distill_run_versions(repo_id,run_id,version_id,projection_checksum,candidate_checksum,created_at) VALUES(?,?,?,?,?,?)`).run(repoRow.id,"baseline-run",version,checksum,"fixture",now);
    fs.writeFileSync(path.join(repo,"src/a.ts"),"new\n");spawnSync("git",["-C",repo,"add","src/a.ts"]);spawnSync("git",["-C",repo,"commit","-qm","target"]);const target=spawnSync("git",["-C",repo,"rev-parse","HEAD"],{encoding:"utf8"}).stdout.trim();
    const helper=spawnSync(process.execPath,[path.join(skills,"scripts/inventory.mjs"),"--repo",repo,"--run-id","mixed-order","--base-commit",base,"--target-commit",target],{encoding:"utf8"});expect(helper.status,helper.stdout+helper.stderr).toBe(0);const raw=JSON.parse(helper.stdout);
    expect(raw.rows.map((row:{path:string})=>row.path)).toEqual(["README.md","readme-link","src/a.ts","é.ts"]);expect(raw.rows).toContainEqual(expect.objectContaining({path:"readme-link",classification:"excluded",reason:"non_regular_file"}));
    const dispatcher=new OperationDispatcher(db),context=(requestId:string)=>({repoId:repoRow.id,actor:"inventory-test",taskId:"inventory-task",requestId,now});
    expect(dispatcher.dispatch("distill.run.start",context("start"),{runId:"mixed-order",mode:"incremental",baseCommit:target,skillHash:"skill",configHash:"config"})).toMatchObject({ok:true});
    expect(dispatcher.dispatch("distill.inventory.put",context("put"),raw)).toMatchObject({ok:true});
    expect(dispatcher.dispatch("distill.inventory.seal",context("seal"),{runId:"mixed-order"})).toMatchObject({ok:true,data:{sealed:true}});
    db.close();fs.rmSync(temp,{recursive:true,force:true});
  });

  it("executes positive and negative workflow schema fixtures",()=>{
    const fixtures:Record<string,unknown>={
      "ingest-plan":{idempotencyKey:"i1",specs:[{id:"context-a",type:"context",summary:"A durable fact",evidence:[{sourceType:"manual",sourceRef:"message:1",exactQuote:"A durable fact"}],anchors:[{file:"src/a.ts",lineStart:1,lineEnd:2}]}]},
      "query-request":{need:"governing context",depth:"L1",paths:["src/a.ts"]},
      "context-packet":{need:"governing context",depth:"L1",facts:[],conflicts:[],missing:[],implications:[],sources:[]},
      "distillation-scope":{runId:"r",scopeId:"s",leaseToken:"l",generation:1,files:["src/a.ts"],candidates:[],coveredFiles:[],unresolvedFiles:[{path:"src/a.ts",reason:"No honest feature placement",evidence:[{sourceRef:"src/a.ts",contentHash:"hash"}]}]},
      "distillation-result":{runId:"r",state:"reconciling",accounting:{inventory:1,excluded:0,covered:0,unresolved:1},unresolvedDispositions:[{path:"src/a.ts",scopeId:"s",reason:"No honest feature placement",evidence:[]}],findings:[],reviewRequired:true},
      "validation-report":{valid:true,schema:"x",errors:[]},
    };
    for(const [schema,value] of Object.entries(fixtures)){
      const positive=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema",schema],{input:JSON.stringify(value),encoding:"utf8"});expect(positive.status,positive.stdout).toBe(0);
      const negative=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema",schema],{input:"{}",encoding:"utf8"});expect(negative.status,negative.stdout).toBe(2);
    }
    const badAnchor={...(fixtures["ingest-plan"] as Record<string,unknown>),specs:[{id:"context-a",type:"context",summary:"A durable fact",evidence:[{sourceType:"manual",sourceRef:"message:1",exactQuote:"A durable fact"}],anchors:[{file:"src/a.ts",lineEnd:2}]}]};
    const invalid=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema","ingest-plan"],{input:JSON.stringify(badAnchor),encoding:"utf8"});expect(invalid.status,invalid.stdout).toBe(2);
    for(const unresolvedFiles of [["src/a.ts"],[{path:"src/a.ts",reason:"Unknown",featureId:"fake"}]]){const invalidScope={...(fixtures["distillation-scope"] as Record<string,unknown>),unresolvedFiles};const checked=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema","distillation-scope"],{input:JSON.stringify(invalidScope),encoding:"utf8"});expect(checked.status,checked.stdout).toBe(2);}
    const scope=fixtures["distillation-scope"] as Record<string,unknown>;
    for(const invalidScope of [
      {...scope,files:["./src/a.ts"],unresolvedFiles:[{path:"./src/a.ts",reason:"Unknown"}]},
      {...scope,files:["src/a.ts","src/b.ts"],unresolvedFiles:[{path:"src/a.ts",reason:"one"},{path:"src/a.ts",reason:"two"}]},
      {...scope,coveredFiles:["src/a.ts"],unresolvedFiles:[{path:"src/a.ts",reason:"overlap"}]},
      {...scope,files:["src/a.ts","src/b.ts"],unresolvedFiles:[{path:"src/a.ts",reason:"partial"}]},
      {...scope,unresolvedFiles:[{path:"src/b.ts",reason:"unowned"}]},
    ]){const checked=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema","distillation-scope"],{input:JSON.stringify(invalidScope),encoding:"utf8"});expect(checked.status,checked.stdout).toBe(2);}
    const result=fixtures["distillation-result"] as Record<string,unknown>;
    for(const invalidResult of [
      {...result,accounting:{inventory:2,excluded:0,covered:0,unresolved:1}},
      {...result,accounting:{inventory:2,excluded:0,covered:0,unresolved:2}},
      {...result,unresolvedDispositions:[{path:"./src/a.ts",scopeId:"s",reason:"bad"}]},
    ]){const checked=spawnSync(process.execPath,[path.join(skills,"scripts/validate-artifact.mjs"),"--schema","distillation-result"],{input:JSON.stringify(invalidResult),encoding:"utf8"});expect(checked.status,checked.stdout).toBe(2);}
  });

  it("runs a packaged wrapper from clean HOME without monorepo paths",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-packaged-skill-"));
    const packaged=path.join(temp,"managed-assets","skills"),home=path.join(temp,"home"),bin=path.join(temp,"bin");
    fs.cpSync(skills,packaged,{recursive:true});fs.mkdirSync(home);fs.mkdirSync(bin);
    const fake=path.join(bin,"vibehub");
    fs.writeFileSync(fake,"#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"data\":{\"states\":{}},\"meta\":{\"operation\":\"kb.status\",\"repoId\":1,\"requestId\":\"clean\",\"at\":\"2026-01-01T00:00:00.000Z\"}}'\n");
    fs.chmodSync(fake,0o755);
    const run=spawnSync(process.execPath,[path.join(packaged,"scripts/vh-kb.mjs"),"status","--repo",temp,"--actor","test","--request","clean"],{input:"{}",encoding:"utf8",env:{HOME:home,PATH:`${bin}:${process.env.PATH??""}`}});
    expect(run.status,run.stdout+run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ok:true,meta:{operation:"kb.status",requestId:"clean"}});
  });

  it("normalizes empty stdin and a zero-byte input file to the same empty object",()=>{
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-empty-wrapper-")),input=path.join(temp,"empty.json"),fake=path.join(temp,"vibehub");
    fs.writeFileSync(input,"");
    fs.writeFileSync(fake,"#!/usr/bin/env node\nlet raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({ok:true,data:{raw},meta:{operation:'kb.status'}})));\n");fs.chmodSync(fake,0o755);
    const invoke=(args:string[],stdin?:string)=>spawnSync(process.execPath,[path.join(skills,"scripts/vh-kb.mjs"),"status",...args],{input:stdin,encoding:"utf8",env:{...process.env,VIBEHUB_BIN:fake}});
    const fromStdin=invoke([],"");const fromFile=invoke(["--input",input]);
    expect(fromStdin.status,fromStdin.stdout+fromStdin.stderr).toBe(0);expect(fromFile.status,fromFile.stdout+fromFile.stderr).toBe(0);
    expect(JSON.parse(fromStdin.stdout).data.raw).toBe("{}");expect(JSON.parse(fromFile.stdout).data.raw).toBe("{}");
  });

  it("requires the artifact gate to use a package-manager bin and a case-local managed root",()=>{
    const gate=fs.readFileSync(path.join(workbench,"scripts/verify-plugin-artifact.mjs"),"utf8");
    expect(gate).toContain("node_modules/.bin/vibehub");
    expect(gate).not.toContain("writeFileSync(launcher");
    expect(gate).toContain("casePluginRoot");
  });

  it("captures large dispatcher envelopes, maps errors/signals, and cleans temp files",async()=>{
    type Capture={kind:string;status:number|null;signal:string|null;stdout:string;stderr:string;observedBytes:number;retainedBytes:number;limit:number};
    const {captureCommand}=await import(path.join(skills,"scripts/_capture.mjs")) as {captureCommand:(command:string,args:string[],options:Record<string,unknown>)=>Promise<Capture>};
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vh-wrapper-")),home=path.join(temp,"home"),bin=path.join(temp,"bin"),captures=path.join(temp,"captures");
    fs.mkdirSync(home);fs.mkdirSync(bin);fs.mkdirSync(captures);
    const fake=path.join(bin,"vibehub");
    const run=async(mode:string,args=["status"])=>{
      fs.writeFileSync(fake,`#!/usr/bin/env node\nconst mode=${JSON.stringify(mode)};if(mode==="signal")process.kill(process.pid,"SIGTERM");if(mode==="overflow"){const fs=require("node:fs"),chunk=Buffer.alloc(1024*1024,120);while(true)fs.writeSync(1,chunk);}const value=mode==="error"?{ok:false,error:{code:"hard_findings",message:"x".repeat(12000),details:null,nextSafeActions:[]}}:{ok:true,data:{payload:"x".repeat(12000)},meta:{operation:"kb.status",repoId:1,requestId:"large",at:"2026-01-01T00:00:00.000Z"}};process.stdout.write(JSON.stringify(value));if(mode==="error")process.exitCode=4;\n`);
      fs.chmodSync(fake,0o755);
      return await captureCommand(process.execPath,[path.join(skills,"scripts/vh-kb.mjs"),...args],{input:"{}",env:{...process.env,HOME:home,TMPDIR:captures,VIBEHUB_BIN:fake}});
    };
    const success=await run("success");expect(success.status).toBe(0);expect(JSON.parse(success.stdout).data.payload).toHaveLength(12000);
    const error=await run("error");expect(error.status).toBe(4);expect(JSON.parse(error.stdout).error.message).toHaveLength(12000);
    const signal=await run("signal");expect(signal.status).toBe(1);expect(JSON.parse(signal.stdout)).toMatchObject({ok:false,error:{code:"cli_terminated"}});
    const overflow=await run("overflow");expect(overflow.status).toBe(1);expect(JSON.parse(overflow.stdout)).toMatchObject({ok:false,error:{code:"response_too_large"}});
    const missing=await run("success",["status","--repo"]);expect(missing.status).toBe(2);expect(JSON.parse(missing.stdout)).toMatchObject({ok:false,error:{code:"validation_error"}});

    const direct=async(code:string,maxBytes=16*1024*1024)=>{
      const result=await captureCommand(process.execPath,["-e",code],{tempRoot:captures,maxBytes});
      expect(fs.readdirSync(captures)).toEqual([]);
      return result;
    };
    const boundedSuccess=await direct(`process.stdout.write("ok");process.stderr.write("warn")`);
    expect(boundedSuccess).toMatchObject({kind:"exit",status:0,stdout:"ok",stderr:"warn",observedBytes:6,retainedBytes:6});
    const boundedNonzero=await direct(`process.stdout.write("bad");process.exit(7)`);
    expect(boundedNonzero).toMatchObject({kind:"exit",status:7,stdout:"bad",retainedBytes:3});
    const splitOverflow=await direct(`const fs=require("node:fs"),b=Buffer.alloc(9*1024*1024,120);fs.writeSync(1,b);fs.writeSync(2,b)`,16*1024*1024);
    expect(splitOverflow.kind).toBe("overflow");
    expect(splitOverflow.observedBytes).toBeGreaterThan(splitOverflow.limit);
    expect(splitOverflow.retainedBytes).toBe(splitOverflow.limit);
    expect(splitOverflow.retainedBytes).toBeLessThanOrEqual(splitOverflow.limit);
    const directSignal=await direct(`process.kill(process.pid,"SIGTERM")`);
    expect(directSignal).toMatchObject({kind:"signal",signal:"SIGTERM",retainedBytes:0});
    const spawnError=await captureCommand(path.join(temp,"does-not-exist"),[],{tempRoot:captures}) as Capture;
    expect(spawnError).toMatchObject({kind:"spawn_error",retainedBytes:0});
    expect(fs.readdirSync(captures)).toEqual([]);
  });
});
