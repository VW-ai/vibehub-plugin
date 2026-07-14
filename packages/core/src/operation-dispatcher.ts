import type { Db } from "./db.js";
import crypto from "node:crypto";
import { z } from "zod";
import { KnowledgeError, KnowledgeService, type DraftBatchInput } from "./knowledge-service.js";
import { DistillationService, type CandidateInput, type DistillationStartInput, type InventoryRowInput, type ScopePlanInput } from "./distillation-service.js";
import { operationContextSchema, operationInputSchemas, type OperationName } from "./operation-contracts.js";

export interface OperationContext { repoId:number; actor:string; taskId?:string; requestId:string; now:string }
export interface OperationMeta { operation:string; repoId:number; requestId:string; at:string }
export type OperationResult<T=unknown> =
  | {ok:true;data:T;meta:OperationMeta}
  | {ok:false;error:{code:string;message:string;details:unknown;nextSafeActions:string[]}};

export const OPERATION_EXIT_CLASS:Record<string,number>={
  validation_error:2, actor_required:2, task_required:2, unsupported_operation:2,
  not_found:3, already_exists:3, invalid_state_transition:4, replacement_not_active:4,
  relation_cycle:4, idempotency_conflict:5, internal_error:1,
  inventory_empty:4, scope_file_partition:4, invalid_scope_parent:4, scopes_unfinished:4,
  stale_lease:5, invalid_supersession:4, hard_findings:4, projection_empty:4,
  version_not_eligible:4, checksum_mismatch:5, cas_conflict:5,
  candidate_set_frozen:4, candidate_snapshot_mismatch:5,
  base_commit_not_found:4, correction_not_required:4, scope_not_implicated:4,
};

interface Services {kb:KnowledgeService;distill:DistillationService}
type Handler=(service:Services,ctx:OperationContext,input:Record<string,unknown>)=>unknown;
const handlers:Record<OperationName,Handler>={
  "kb.status":(s,c)=>s.kb.status(c.repoId),
  "kb.feature.list":(s,c,i)=>s.kb.listFeatures(c.repoId,i),
  "kb.feature.get":(s,c,i)=>s.kb.getFeature(c.repoId,req(i.id,"id")),
  "kb.feature.suggest":(s,c,i)=>s.kb.listFeatures(c.repoId,i),
  "kb.spec.search":(s,c,i)=>s.kb.searchSpecs(c.repoId,i),
  "kb.spec.get":(s,c,i)=>s.kb.getSpec(c.repoId,req(i.id,"id")),
  "kb.relations":(s,c,i)=>s.kb.traverseRelations(c.repoId,i as Parameters<KnowledgeService["traverseRelations"]>[1]),
  "kb.lineage":(s,c,i)=>s.kb.resolveLineage(c.repoId,req(i.id,"id"),i.maxDepth as number|undefined),
  "kb.anchors":(s,c,i)=>s.kb.anchors(c.repoId,i),
  "kb.review":(s,c,i)=>s.kb.review(c.repoId,i),
  "kb.ingest.preview":(s,c,i)=>s.kb.previewIngest(c.repoId,i as Parameters<KnowledgeService["previewIngest"]>[1]),
  "kb.draft.apply":(s,c,i)=>s.kb.applyDraftBatch(c.repoId,i as unknown as DraftBatchInput,mutation(c,true)),
  "kb.promote":(s,c,i)=>s.kb.mutate(c.repoId,"promote",i,mutation(c,false)),
  "kb.mark-stale":(s,c,i)=>s.kb.mutate(c.repoId,"mark_stale",i,mutation(c,false)),
  "kb.deprecate":(s,c,i)=>s.kb.mutate(c.repoId,"deprecate",i,mutation(c,false)),
  "kb.amend":(s,c,i)=>s.kb.mutate(c.repoId,"amend",i,mutation(c,false)),
  "kb.supersede":(s,c,i)=>s.kb.mutate(c.repoId,"supersede",i,mutation(c,false)),
  "distill.run.start":(s,c,i)=>s.distill.start(c.repoId,i as unknown as DistillationStartInput,mutation(c,true)),
  "distill.run.status":(s,c,i)=>s.distill.status(c.repoId,req(i.runId,"runId")),
  "distill.run.resume":(s,c,i)=>s.distill.resume(c.repoId,i as {runId:string},mutation(c,true)),
  "distill.run.abort":(s,c,i)=>s.distill.abort(c.repoId,i as {runId:string;reason:string},mutation(c,true)),
  "distill.inventory.put":(s,c,i)=>s.distill.putInventory(c.repoId,i as unknown as {runId:string;rows:InventoryRowInput[]},mutation(c,true)),
  "distill.inventory.get":(s,c,i)=>s.distill.getInventory(c.repoId,req(i.runId,"runId")),
  "distill.inventory.diff":(s,c,i)=>s.distill.diffInventory(c.repoId,i as {runId:string;paths:string[]}),
  "distill.inventory.seal":(s,c,i)=>s.distill.sealInventory(c.repoId,i as {runId:string},mutation(c,true)),
  "distill.scopes.plan":(s,c,i)=>s.distill.planScopes(c.repoId,i as unknown as {runId:string;scopes:ScopePlanInput[]},mutation(c,true)),
  "distill.scopes.claim":(s,c,i)=>s.distill.claimScope(c.repoId,i as {runId:string;workerId:string;leaseSeconds:number},mutation(c,true)),
  "distill.scopes.complete":(s,c,i)=>s.distill.completeScope(c.repoId,i as {runId:string;scopeId:string;leaseToken:string;generation:number;coveredFiles:string[]},mutation(c,true)),
  "distill.scopes.fail":(s,c,i)=>s.distill.failScope(c.repoId,i as {runId:string;scopeId:string;leaseToken:string;generation:number;reason:string;coveredFiles?:string[]},mutation(c,true)),
  "distill.scopes.retry":(s,c,i)=>s.distill.retryScope(c.repoId,i as {runId:string;scopeId:string;reason:string},mutation(c,true)),
  "distill.scopes.correct":(s,c,i)=>s.distill.correctScopes(c.repoId,i as {runId:string;scopeIds:string[];reason:string},mutation(c,true)),
  "distill.candidates.put":(s,c,i)=>s.distill.putCandidate(c.repoId,i as unknown as CandidateInput,mutation(c,true)),
  "distill.candidates.get":(s,c,i)=>s.distill.getCandidate(c.repoId,i as {runId?:string;versionId?:string;kind:"feature"|"spec"|"anchor"|"relation";naturalId:string;revisionHash?:string}),
  "distill.candidates.list":(s,c,i)=>s.distill.listCandidates(c.repoId,i as {runId?:string;versionId?:string;kind?:"feature"|"spec"|"anchor"|"relation";limit?:number;offset?:number}),
  "distill.baseline.get":(s,c)=>s.distill.baseline(c.repoId),
  "distill.version.get":(s,c,i)=>s.distill.getVersion(c.repoId,req(i.versionId,"versionId")),
  "distill.version.diff":(s,c,i)=>s.distill.getVersionDiff(c.repoId,i as {versionId:string;kinds?:Array<"feature"|"spec"|"anchor">}),
  "distill.reconcile":(s,c,i)=>s.distill.reconcile(c.repoId,i as {runId:string},mutation(c,true)),
  "distill.validate":(s,c,i)=>s.distill.validate(c.repoId,i as {runId:string},mutation(c,true)),
  "distill.finalize":(s,c,i)=>s.distill.finalize(c.repoId,i as {runId:string},mutation(c,true)),
  "distill.activate":(s,c,i)=>s.distill.activate(c.repoId,i as {targetVersionId:string;expectedCurrentVersion:string|null;reason:string},mutation(c,true)),
  "distill.rollback":(s,c,i)=>s.distill.rollback(c.repoId,i as {targetVersionId:string;expectedCurrentVersion:string|null;reason:string},mutation(c,true)),
};

export class OperationDispatcher {
  private readonly service:Services;
  constructor(private readonly db:Db){this.service={kb:new KnowledgeService(db),distill:new DistillationService(db)};}
  operations():string[]{return Object.keys(handlers).sort();}
  dispatch(operation:string,context:unknown,input:unknown={}):OperationResult{
    const address=receiptAddressSchema.safeParse(context);
    if(address.success){
      const raw=context as Record<string,unknown>;
      const payloadHash=hashCanonical({actor:raw.actor??null,taskId:raw.taskId??null,input});
      try{return this.dispatchRequest(operation,address.data.repoId,address.data.requestId,payloadHash,typeof raw.now==="string"?raw.now:"1970-01-01T00:00:00.000Z",()=>this.invoke(operation,context,input));}
      catch(error){return failure(error);}
    }
    try{return this.invoke(operation,context,input);}catch(error){return failure(error);}
  }
  private invoke(operation:string,context:unknown,input:unknown):OperationResult{
    const schema=operationInputSchemas[operation as OperationName];const handler=handlers[operation as OperationName];
    if(!schema||!handler)throw new KnowledgeError("unsupported_operation",`unsupported operation: ${operation}`,{operation},["List dispatcher operations and choose a registered operation."]);
    const parsedContext=operationContextSchema.safeParse(context);
    if(!parsedContext.success){
      const actorProbe=actorProbeSchema.safeParse(context);
      if(actorProbe.success&&(actorProbe.data.actor===undefined||(typeof actorProbe.data.actor==="string"&&!actorProbe.data.actor.trim())))throw new KnowledgeError("actor_required","actor is required",null,["Provide the calling human or agent identity."]);
      throw validation(parsedContext.error.issues,"context");
    }
    const parsedInput=schema.safeParse(input);if(!parsedInput.success)throw validation(parsedInput.error.issues,"input");
    const c=parsedContext.data as OperationContext;const normalizedInput=parsedInput.data as Record<string,unknown>;
    const data=DISTILL_MUTATIONS.has(operation)?this.dispatchDistillMutation(operation,c,normalizedInput,handler):handler(this.service,c,normalizedInput);
    return {ok:true,data,meta:{operation,repoId:c.repoId,requestId:c.requestId,at:c.now}};
  }
  private dispatchRequest(operation:string,repoId:number,requestId:string,payloadHash:string,createdAt:string,invoke:()=>OperationResult){
    return this.db.transaction(()=>{
      const prior=this.db.prepare(`SELECT operation,payload_hash payloadHash,outcome_kind outcomeKind,outcome FROM operation_request_receipts WHERE repo_id=? AND request_id=?`).get(repoId,requestId) as {operation:string;payloadHash:string;outcomeKind:"success"|"error";outcome:string}|undefined;
      if(prior){
        if(prior.operation!==operation||prior.payloadHash!==payloadHash)throw new KnowledgeError("idempotency_conflict","requestId was reused with a different operation, actor, task, or canonical input",{requestId,originalOperation:prior.operation,attemptedOperation:operation},["Use a new requestId for a different logical invocation."]);
        return JSON.parse(prior.outcome) as OperationResult;
      }
      this.db.exec("SAVEPOINT operation_request_handler");
      let outcome:OperationResult;
      try{
        outcome=invoke();
        this.db.exec("RELEASE SAVEPOINT operation_request_handler");
      }catch(error){
        this.db.exec("ROLLBACK TO SAVEPOINT operation_request_handler");
        this.db.exec("RELEASE SAVEPOINT operation_request_handler");
        outcome=failure(error);
      }
      this.db.prepare(`INSERT INTO operation_request_receipts(repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at) VALUES(?,?,?,?,?,?,?)`).run(repoId,requestId,operation,payloadHash,outcome.ok?"success":"error",JSON.stringify(outcome),createdAt);
      return outcome;
    }).immediate();
  }
  private dispatchDistillMutation(operation:string,c:OperationContext,input:Record<string,unknown>,handler:Handler){const stable=(value:unknown):string=>JSON.stringify(sortObject(value));const inputHash=crypto.createHash("sha256").update(stable({input,actor:c.actor,taskId:c.taskId??null})).digest("hex");return this.db.transaction(()=>{const prior=this.db.prepare(`SELECT input_hash inputHash,result FROM distill_mutation_receipts WHERE repo_id=? AND operation=? AND request_id=?`).get(c.repoId,operation,c.requestId) as {inputHash:string;result:string}|undefined;if(prior){if(prior.inputHash!==inputHash)throw new KnowledgeError("idempotency_conflict","requestId was reused with different mutation input",{operation,requestId:c.requestId},["Use a new requestId for a different mutation."]);return JSON.parse(prior.result);}const result=handler(this.service,c,input);this.db.prepare(`INSERT INTO distill_mutation_receipts(repo_id,operation,request_id,input_hash,result,created_at) VALUES(?,?,?,?,?,?)`).run(c.repoId,operation,c.requestId,inputHash,stable(result),c.now);return result;}).immediate();}
}

const DISTILL_MUTATIONS=new Set(["distill.run.start","distill.run.abort","distill.inventory.put","distill.inventory.seal","distill.scopes.plan","distill.scopes.claim","distill.scopes.complete","distill.scopes.fail","distill.scopes.retry","distill.scopes.correct","distill.candidates.put","distill.reconcile","distill.validate","distill.finalize","distill.activate","distill.rollback"]);
function sortObject(value:unknown):unknown{return Array.isArray(value)?value.map(sortObject):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,sortObject(v)])):value;}

const actorProbeSchema=z.object({actor:z.unknown().optional()}).passthrough();
const receiptAddressSchema=z.object({repoId:operationContextSchema.shape.repoId,requestId:operationContextSchema.shape.requestId}).passthrough();
function hashCanonical(value:unknown){return crypto.createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex");}
function failure(error:unknown):OperationResult{const e=normalize(error);return {ok:false,error:{code:e.code,message:e.message,details:e.details,nextSafeActions:e.nextSafeActions}};}

function mutation(c:OperationContext,taskRequired:boolean){if(taskRequired&&!c.taskId?.trim())throw new KnowledgeError("task_required","taskId is required for draft batch apply",null,["Associate the write with the current task."]);return {actor:c.actor,taskId:c.taskId,requestId:c.requestId,now:c.now};}
function req(v:unknown,name:string){if(typeof v!=="string"||!v.trim())throw new KnowledgeError("validation_error",`${name} is required`,{field:name});return v;}
function normalize(error:unknown):KnowledgeError{if(error instanceof KnowledgeError)return error;const message=error instanceof Error?error.message:String(error);if(message.includes("FOREIGN KEY"))return new KnowledgeError("not_found","referenced entity does not exist",{cause:message});if(message.includes("UNIQUE"))return new KnowledgeError("already_exists","entity already exists",{cause:message});return new KnowledgeError("internal_error","knowledge operation failed",{cause:message},["Retry after inspecting database health."]);}
function validation(issues:readonly {path:PropertyKey[];message:string;code:string}[],scope:string){return new KnowledgeError("validation_error",`invalid ${scope}`,{issues:issues.map(x=>({path:x.path.map(String),message:x.message,code:x.code}))},["Correct the malformed request and retry."]);}
