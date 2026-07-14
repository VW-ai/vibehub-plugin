import {afterEach,beforeEach,describe,expect,it} from "vitest";
import fs from "node:fs";import os from "node:os";import path from "node:path";
import {Worker} from "node:worker_threads";import {vi} from "vitest";
import {KnowledgeService,OperationDispatcher,openDb,upsertRepo,type Db,type OperationContext} from "../src/index.js";
import {seedActiveMapping} from "./kb-fixtures.js";

const NOW="2026-07-13T12:00:00.000Z";
const evidence=[{sourceType:"conversation",sourceRef:"chat:1",exactQuote:"Keep the database canonical",confidence:.9}];
describe("KnowledgeService canonical boundary",()=>{
  let db:Db,dir:string,service:KnowledgeService,dispatch:OperationDispatcher,ctx:OperationContext;
  beforeEach(()=>{dir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-kb-"));db=openDb(path.join(dir,"db.sqlite"));upsertRepo(db,"/repo",null,"main",NOW);seedActiveMapping(db,1,[{id:"auth",name:"Auth"}],NOW);service=new KnowledgeService(db);dispatch=new OperationDispatcher(db);ctx={repoId:1,actor:"wayne",taskId:"task:1",requestId:"req:1",now:NOW};});
  afterEach(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const draft=(id:string,summary=id)=>({id,featureId:"auth",type:"decision" as const,summary,evidence,anchors:[{file:"src/auth/session.ts",symbol:"session"}]});

  it("applies an atomic idempotent batch and rejects key hash conflicts",()=>{
    const input={idempotencyKey:"batch-1",specs:[draft("decision-a"),draft("decision-b")]};
    expect(service.applyDraftBatch(1,input,ctx)).toEqual(service.applyDraftBatch(1,input,ctx));
    expect(()=>service.applyDraftBatch(1,{...input,specs:[draft("decision-c")]},ctx)).toThrow(/idempotency key/i);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_specs`).get() as {n:number}).n).toBe(2);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"bad",specs:[draft("decision-c"),{...draft("decision-d"),evidence:[]}]},ctx)).toThrow(/validation_error/);
    expect(db.prepare(`SELECT 1 FROM kb_specs WHERE spec_id='decision-c'`).get()).toBeUndefined();
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:" padded ",specs:[draft("decision-e")]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"canonical",specs:[draft(" decision-e")]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"canonical",specs:[{...draft("decision-e"),evidence:[{...evidence[0]!,sourceRef:"chat:1 "}]}]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"optional-ref",specs:[{...draft("decision-e"),evidence:[{...evidence[0]!,evidenceRef:" ref "}]}]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"optional-tag",specs:[{...draft("decision-e"),tags:[" tag "]}]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"optional-hash",specs:[{...draft("decision-e"),anchors:[{file:"src/a.ts",contentHash:" hash "}]}]},ctx)).toThrow(/validation_error/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"path",specs:[{...draft("decision-e"),anchors:[{file:"./src/a.ts"}]}]},ctx)).toThrow(/validation_error/);
    expect(()=>service.previewIngest(1,{specs:[{summary:" padded "}]})).toThrow(/validation_error/);
  });

  it("enforces lifecycle, immutable amendment history and supersede replacement rules",()=>{
    service.applyDraftBatch(1,{idempotencyKey:"seed",specs:[draft("old"),draft("new")]},ctx);
    service.mutate(1,"promote",{specId:"old",idempotencyKey:"p-old"},ctx);
    const amended=service.mutate(1,"amend",{specId:"old",summary:"amended",evidence,idempotencyKey:"a-old"},ctx) as {revision:number};
    expect(amended.revision).toBe(2);expect(service.getSpec(1,"old").state).toBe("active");expect(service.getSpec(1,"old").revisions).toHaveLength(2);expect(service.getSpec(1,"old").revisions[1].anchors).toEqual([{revision:2,file:"src/auth/session.ts",symbol:"session",lineStart:null,lineEnd:null,contentHash:null}]);
    expect(()=>service.mutate(1,"supersede",{specId:"old",replacementSpecId:"new",idempotencyKey:"s-no"},ctx)).toThrow(/replacement must be active/);
    service.mutate(1,"supersede",{specId:"old",replacementSpecId:"new",promoteReplacement:true,idempotencyKey:"s-yes"},ctx);
    expect(service.resolveLineage(1,"old")).toEqual({from:"old",to:"new",chain:["old","new"],maxDepth:100,truncated:false});
    expect(service.resolveLineage(1,"old",1)).toEqual({from:"old",to:"old",chain:["old"],maxDepth:1,truncated:true});
    expect(service.traverseRelations(1,{specId:"old",direction:"both",depth:2}).edges).toHaveLength(1);
    expect(()=>service.mutate(1,"promote",{specId:"old",idempotencyKey:"again"},ctx)).toThrow(/cannot transition/);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_provenance_events`).get() as {n:number}).n).toBeGreaterThanOrEqual(6);
  });

  it("defaults search to active, honors directory containment and reports unplaced/review queues",()=>{
    service.applyDraftBatch(1,{idempotencyKey:"seed",specs:[draft("active","database canonical"),{...draft("unplaced","unplaced"),featureId:undefined,evidence:[{...evidence[0]!,confidence:.4}]}]},ctx);
    service.mutate(1,"promote",{specId:"active",idempotencyKey:"p1"},ctx);service.mutate(1,"promote",{specId:"unplaced",idempotencyKey:"p2"},ctx);service.mutate(1,"mark_stale",{specId:"active",idempotencyKey:"stale"},ctx);
    expect(service.searchSpecs(1,{query:"database"})).toMatchObject({items:[],count:0,total:0,hasMore:false});
    expect(service.searchSpecs(1,{paths:["src/auth"],includeHistory:true}).items[0]?.id).toBe("active");
    expect(service.review(1).items.map(x=>x.kind)).toEqual(expect.arrayContaining(["low_confidence","stale","unplaced"]));
    expect(service.status(1).activeMapping).not.toBeNull();
    expect(()=>service.searchSpecs(1,{query:" database "})).toThrow(/validation_error/);
    expect(()=>service.searchSpecs(1,{paths:["./src/auth"]})).toThrow(/validation_error/);
    expect(()=>service.searchSpecs(1,{tags:[" stale "]})).toThrow(/validation_error/);
    expect(()=>service.listFeatures(999,{query:" auth "})).toThrow(/validation_error/);
  });

  it("validates relation cycles, cross-repo identities, evidence and anchor ranges",()=>{
    service.applyDraftBatch(1,{idempotencyKey:"seed",specs:[{...draft("a"),relations:[{toSpecId:"b",type:"depends_on"}]},draft("b")]},ctx);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"cycle",specs:[{...draft("c"),relations:[{toSpecId:"a",type:"depends_on"},{toSpecId:"c",type:"depends_on"}]}]},ctx)).toThrow(/self relation/);
    expect(()=>service.applyDraftBatch(1,{idempotencyKey:"line",specs:[{...draft("bad"),anchors:[{file:"src/x.ts",lineStart:5,lineEnd:2}]}]},ctx)).toThrow(/validation_error/);
    upsertRepo(db,"/other",null,"main",NOW);expect(()=>new KnowledgeService(db).getSpec(2,"a")).toThrow(/not found/);
  });

  it("dispatcher returns exact envelopes and explicit actor/task/error classes",()=>{
    expect(dispatch.dispatch("kb.status",{...ctx,repoId:0},{})).toMatchObject({ok:false,error:{code:"validation_error"}});
    const noActor=dispatch.dispatch("kb.status",{...ctx,actor:"",requestId:"req:no-actor"},{});expect(noActor).toMatchObject({ok:false,error:{code:"actor_required"}});
    const noTask=dispatch.dispatch("kb.draft.apply",{...ctx,taskId:undefined,requestId:"req:no-task"},{idempotencyKey:"x",specs:[draft("x")]});expect(noTask).toMatchObject({ok:false,error:{code:"task_required"}});
    const ok=dispatch.dispatch("kb.draft.apply",ctx,{idempotencyKey:"x",specs:[draft("x")]});expect(ok).toMatchObject({ok:true,meta:{operation:"kb.draft.apply",repoId:1,requestId:"req:1"}});
    expect(dispatch.dispatch("kb.draft.apply",{...ctx,requestId:"req:2"},{idempotencyKey:"other",specs:[draft("x")]})).toMatchObject({ok:false,error:{code:"already_exists"}});
    expect(dispatch.dispatch("kb.draft.apply",{...ctx,requestId:"req:3"},{idempotencyKey:"x",specs:[draft("different")]})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.promote",{...ctx,requestId:"req:4"},{specId:"x",idempotencyKey:"p"})).toMatchObject({ok:true});
    expect(dispatch.dispatch("kb.promote",{...ctx,requestId:"req:5"},{specId:"x",idempotencyKey:"p2"})).toMatchObject({ok:false,error:{code:"invalid_state_transition"}});
    expect(dispatch.dispatch("kb.draft.apply",{...ctx,requestId:"req:6"},{idempotencyKey:"y",specs:[draft("y")]})).toMatchObject({ok:true});
    expect(dispatch.dispatch("kb.supersede",{...ctx,requestId:"req:7"},{specId:"x",replacementSpecId:"y",idempotencyKey:"s"})).toMatchObject({ok:false,error:{code:"replacement_not_active"}});
    expect(dispatch.dispatch("kb.draft.apply",{...ctx,requestId:"req:8"},{idempotencyKey:"cycle",specs:[{...draft("z"),relations:[{toSpecId:"z",type:"depends_on"}]}]})).toMatchObject({ok:false,error:{code:"relation_cycle"}});
    expect(dispatch.dispatch("kb.nope",{...ctx,requestId:"req:unsupported"},{})).toMatchObject({ok:false,error:{code:"unsupported_operation"}});
    expect(dispatch.dispatch("kb.spec.get",{...ctx,requestId:"req:9"},{id:"elsewhere"})).toMatchObject({ok:false,error:{code:"not_found"}});
    const otherDir=fs.mkdtempSync(path.join(os.tmpdir(),"vh-kb-closed-"));const closed=openDb(path.join(otherDir,"db.sqlite"));closed.close();
    expect(new OperationDispatcher(closed).dispatch("kb.status",ctx,{})).toMatchObject({ok:false,error:{code:"internal_error"}});fs.rmSync(otherDir,{recursive:true,force:true});
  });

  it("binds one repository request id to one operation and canonical payload",()=>{
    const request={...ctx,requestId:"repo-request"};
    const input={idempotencyKey:"business-a",specs:[draft("request-bound")]};
    const first=dispatch.dispatch("kb.draft.apply",request,input);
    expect(first).toMatchObject({ok:true});
    expect(dispatch.dispatch("kb.draft.apply",{...request,now:"2026-07-13T12:05:00.000Z"},input)).toEqual(first);
    expect(dispatch.dispatch("kb.draft.apply",request,{...input,idempotencyKey:"business-b",specs:[draft("changed")]})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.status",request,{})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.draft.apply",{...request,requestId:"repo-request-2"},{idempotencyKey:"business-b",specs:[draft("changed")]})).toMatchObject({ok:true});
  });

  it("binds repository receipts to actor and task while excluding now",()=>{
    const request={...ctx,requestId:"identity-bound"};
    const first=dispatch.dispatch("kb.status",request,{});
    expect(first).toMatchObject({ok:true});
    expect(dispatch.dispatch("kb.status",{...request,now:"2026-07-13T12:30:00.000Z"},{})).toEqual(first);
    expect(dispatch.dispatch("kb.status",{...request,actor:"victor"},{})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.status",{...request,taskId:"task:2"},{})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
  });

  it("receipts malformed input and unsupported operations once repository identity is addressable",()=>{
    const malformed={...ctx,requestId:"malformed-reserved"};
    const bad=dispatch.dispatch("kb.feature.get",malformed,{id:""});
    expect(bad).toMatchObject({ok:false,error:{code:"validation_error"}});
    expect(dispatch.dispatch("kb.feature.get",{...malformed,now:"2026-07-13T12:30:00.000Z"},{id:""})).toEqual(bad);
    expect(dispatch.dispatch("kb.feature.get",malformed,{id:"different"})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.status",malformed,{})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});

    const unsupported={...ctx,requestId:"unsupported-reserved"};
    const first=dispatch.dispatch("legacy.removed",unsupported,{value:1});
    expect(first).toMatchObject({ok:false,error:{code:"unsupported_operation"}});
    expect(dispatch.dispatch("legacy.removed",unsupported,{value:1})).toEqual(first);
    expect(dispatch.dispatch("legacy.removed",{...unsupported,actor:"other"},{value:1})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("legacy.removed",unsupported,{value:2})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
  });

  it("does not receipt context failures without a usable repository receipt address",()=>{
    const missingRequest=dispatch.dispatch("kb.status",{repoId:1,actor:"wayne",now:NOW},{});
    expect(missingRequest).toMatchObject({ok:false,error:{code:"validation_error"}});
    expect((db.prepare(`SELECT COUNT(*) n FROM operation_request_receipts`).get() as {n:number}).n).toBe(0);
  });

  it("persists and replays typed handler failures without partial side effects",()=>{
    service.applyDraftBatch(1,{idempotencyKey:"failure-seed",specs:[draft("failure-old"),draft("failure-new")]},ctx);
    const request={...ctx,requestId:"failed-request"};
    const input={specId:"failure-old",replacementSpecId:"failure-new",promoteReplacement:true,idempotencyKey:"failed-supersede"};
    const first=dispatch.dispatch("kb.supersede",request,input);
    expect(first).toMatchObject({ok:false,error:{code:"invalid_state_transition"}});
    expect(db.prepare(`SELECT outcome_kind outcomeKind,json_extract(outcome,'$.ok') ok FROM operation_request_receipts WHERE repo_id=1 AND request_id='failed-request'`).get()).toEqual({outcomeKind:"error",ok:0});
    expect(()=>db.prepare(`INSERT INTO operation_request_receipts(repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at) VALUES(1,'lying-outcome','kb.status','hash','success',?,?)`).run(JSON.stringify(first),NOW)).toThrow(/CHECK constraint/);
    expect(service.getSpec(1,"failure-new").state).toBe("draft");
    expect(service.getSpec(1,"failure-old").relations).toEqual([]);
    service.mutate(1,"promote",{specId:"failure-old",idempotencyKey:"make-old-valid"},ctx);
    service.mutate(1,"promote",{specId:"failure-new",idempotencyKey:"make-new-valid"},ctx);
    expect(dispatch.dispatch("kb.supersede",{...request,now:"2026-07-13T12:10:00.000Z"},input)).toEqual(first);
    expect(dispatch.dispatch("kb.supersede",request,{...input,idempotencyKey:"changed-business-key"})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(dispatch.dispatch("kb.status",request,{})).toMatchObject({ok:false,error:{code:"idempotency_conflict"}});
    expect(service.getSpec(1,"failure-old").relations).toEqual([]);
  });

  it("validates malformed context and every registered operation before service execution",()=>{const malformed:Record<string,unknown>={"kb.status":{extra:true},"kb.feature.list":{limit:0},"kb.feature.get":{id:""},"kb.feature.suggest":{offset:-1},"kb.spec.search":{types:["bogus"]},"kb.spec.get":{},"kb.relations":{specId:"x",direction:"sideways"},"kb.lineage":{id:"x",maxDepth:101},"kb.anchors":{},"kb.review":{kinds:["unknown"]},"kb.ingest.preview":{specs:[]},"kb.draft.apply":{idempotencyKey:"x",specs:[]},"kb.promote":{specId:"x"},"kb.mark-stale":{specId:"x",idempotencyKey:""},"kb.deprecate":{specId:"x",idempotencyKey:"x",extra:1},"kb.amend":{specId:"x",idempotencyKey:"x",evidence:[]},"kb.supersede":{specId:"x",idempotencyKey:"x",replacementSpecId:""}};for(const [index,[op,input]] of Object.entries(malformed).entries())expect(dispatch.dispatch(op,{...ctx,requestId:`malformed-${index}`},input),op).toMatchObject({ok:false,error:{code:"validation_error"}});for(const [index,badContext] of [null,undefined,42,[],{...ctx,actor:42,requestId:"bad-actor-type"},{...ctx,now:"yesterday",requestId:"bad-now"}].entries())expect(dispatch.dispatch("kb.status",badContext,{}),String(index)).toMatchObject({ok:false,error:{code:"validation_error"}});expect(dispatch.dispatch("kb.status",{repoId:ctx.repoId,requestId:"missing-actor",now:ctx.now},{})).toMatchObject({ok:false,error:{code:"actor_required"}});expect(dispatch.dispatch("kb.status",{...ctx,actor:"   ",requestId:"blank-actor"},{})).toMatchObject({ok:false,error:{code:"actor_required"}});});

  it("validates direct service inputs and mutation context before database work",()=>{
    const invalid=(call:()=>unknown)=>{try{call();throw new Error("expected validation failure");}catch(error){expect(error).toMatchObject({code:"validation_error"});}};
    invalid(()=>service.getFeature(1," "));
    invalid(()=>service.traverseRelations(1,{specId:"x",depth:6}));
    invalid(()=>service.anchors(1,{specId:"x",path:"src/a.ts"}));
    invalid(()=>service.review(1,{kinds:["bogus" as "stale"]}));
    invalid(()=>service.applyDraftBatch(1,{idempotencyKey:"direct",specs:[draft("direct")]},{...ctx,now:"yesterday"}));
    invalid(()=>service.mutate(1,"promote",{specId:"direct",idempotencyKey:"promote"},{...ctx,requestId:" "}));
    invalid(()=>service.applyDraftBatch(0,{idempotencyKey:"spoofed-repo",specs:[draft("spoofed-repo")]},{...ctx,repoId:1} as OperationContext));
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_specs`).get() as {n:number}).n).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM kb_mutation_receipts`).get() as {n:number}).n).toBe(0);
  });

  it("returns honest bounded search pagination after ranking the complete filtered set",()=>{service.applyDraftBatch(1,{idempotencyKey:"ranking",specs:[{...draft("a-early","alpha"),detail:"none",anchors:[{file:"src/auth/a.ts"}]},{...draft("m-detail","unrelated"),detail:"beta",anchors:[{file:"src/auth/m.ts"}]},{...draft("z-best","alpha beta"),anchors:[{file:"src/auth/z.ts"},{file:"src/shared/z.ts"}]}]},ctx);expect(service.searchSpecs(1,{query:"alpha beta",includeDrafts:true,limit:1})).toMatchObject({items:[{id:"z-best"}],count:1,total:3,limit:1,offset:0,hasMore:true,truncated:true});expect(service.searchSpecs(1,{query:"alpha beta",includeDrafts:true,offset:2})).toMatchObject({items:[{id:"m-detail"}],count:1,total:3,limit:50,offset:2,hasMore:false,truncated:false});expect(service.searchSpecs(1,{paths:["src/auth","src/shared"],includeDrafts:true,limit:1})).toMatchObject({items:[{id:"z-best"}],total:3,hasMore:true});});

  it("uses direct exact reads and bounded SQL pagination beyond 200 rows",()=>{for(let batch=0;batch<3;batch++){service.applyDraftBatch(1,{idempotencyKey:`bulk-${batch}`,specs:Array.from({length:100},(_,i)=>({...draft(`bulk-${batch*100+i}`),featureId:undefined,anchors:[]}))},{...ctx,requestId:`bulk-${batch}`});}expect(service.getSpec(1,"bulk-299").id).toBe("bulk-299");const spy=vi.spyOn(db,"prepare");const page=service.searchSpecs(1,{includeDrafts:true,limit:3,offset:250});expect(page.items).toHaveLength(3);expect(page).toMatchObject({count:3,total:300,limit:3,offset:250,hasMore:true,truncated:true});const searchSql=spy.mock.calls.map(x=>String(x[0])).find(x=>x.includes("FROM kb_specs s")&&x.includes("LIMIT ? OFFSET ?"));expect(searchSql).toBeTruthy();expect(spy.mock.calls.filter(x=>String(x[0]).includes("kb_spec_current_anchors")).length).toBeLessThanOrEqual(1);spy.mockRestore();expect(service.review(1,{kinds:["unplaced"],limit:25,offset:225})).toMatchObject({total:300,limit:25,offset:225});expect(service.review(1,{kinds:["unplaced"],limit:25,offset:225}).items).toHaveLength(25);expect(service.getFeature(1,"auth").id).toBe("auth");});

  it("review excludes terminal lifecycle states from unplaced and low-confidence queues",()=>{service.applyDraftBatch(1,{idempotencyKey:"review-lifecycle",specs:[{...draft("review-active"),featureId:undefined,evidence:[{...evidence[0]!,confidence:.4}]},{...draft("review-deprecated"),featureId:undefined,evidence:[{...evidence[0]!,confidence:.4}]}]},ctx);service.mutate(1,"promote",{specId:"review-active",idempotencyKey:"review-active-promote"},ctx);service.mutate(1,"deprecate",{specId:"review-deprecated",idempotencyKey:"review-deprecate"},ctx);const review=service.review(1);expect(review.items.map(x=>x.specId)).toContain("review-active");expect(review.items.map(x=>x.specId)).not.toContain("review-deprecated");});

  it("gets an exact feature beyond the first 200 active mapping rows",()=>{seedActiveMapping(db,1,Array.from({length:300},(_,i)=>({id:`feature-${String(i).padStart(3,"0")}`,name:`Feature ${i}`})),NOW);expect(service.getFeature(1,"feature-299").id).toBe("feature-299");expect(service.listFeatures(1,{limit:5})).toHaveLength(5);});

  it("serializes genuine two-worker idempotency races across SQLite connections",async()=>{
    service.applyDraftBatch(1,{idempotencyKey:"race-failure-seed",specs:[draft("race-failure-existing")]},ctx);
    db.close();
    const workerUrl=new URL("./fixtures/kb-idempotency-worker.mjs",import.meta.url);
    const runPair=async(inputs:[unknown,unknown],requestId=(i:number)=>`worker-${i}`)=>{
      const gate=new SharedArrayBuffer(4);
      return Promise.all(inputs.map((input,i)=>new Promise((resolve,reject)=>{
        const worker=new Worker(workerUrl,{workerData:{gate,dbPath:path.join(dir,"db.sqlite"),context:{...ctx,requestId:requestId(i)},input}});
        worker.once("message",resolve);worker.once("error",reject);
      })));
    };
    const same={idempotencyKey:"race-same",specs:[draft("race-same-spec")]};
    const sameResults=await runPair([same,same],i=>`same-${i}`) as Array<{ok:boolean;data?:unknown;error?:{code:string}}>;
    expect(sameResults.every(x=>x.ok)).toBe(true);expect(sameResults[0]?.data).toEqual(sameResults[1]?.data);
    const diff=await runPair([{idempotencyKey:"race-diff",specs:[draft("race-a")]},{idempotencyKey:"race-diff",specs:[draft("race-b")]}],i=>`diff-${i}`) as Array<{ok:boolean;error?:{code:string}}>;
    expect(diff.filter(x=>x.ok)).toHaveLength(1);expect(diff.find(x=>!x.ok)?.error?.code).toBe("idempotency_conflict");
    const requestRace=await runPair([{idempotencyKey:"request-race-a",specs:[draft("request-race-a")]},{idempotencyKey:"request-race-b",specs:[draft("request-race-b")]}],()=>"shared-request") as Array<{ok:boolean;error?:{code:string}}>;
    expect(requestRace.filter(x=>x.ok)).toHaveLength(1);
    expect(requestRace.find(x=>!x.ok)?.error?.code).toBe("idempotency_conflict");
    const failedInput={idempotencyKey:"race-failure",specs:[draft("race-failure-existing")]};
    const failedRace=await runPair([failedInput,failedInput],()=>"shared-failure") as Array<{ok:boolean;error?:{code:string}}>;
    expect(failedRace).toHaveLength(2);expect(failedRace.every(x=>!x.ok&&x.error?.code==="already_exists")).toBe(true);expect(failedRace[0]).toEqual(failedRace[1]);
    db=openDb(path.join(dir,"db.sqlite"));
  });
});
