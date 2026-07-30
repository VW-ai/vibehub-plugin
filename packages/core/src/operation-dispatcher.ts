import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "./db.js";
import crypto from "node:crypto";
import { z } from "zod";
import { KnowledgeError, KnowledgeService, type SpecBatchInput } from "./knowledge-service.js";
import { DistillationService, type CandidateInput, type DistillationStartInput, type InventoryRowInput, type ScopePlanInput } from "./distillation-service.js";
import {
  OPERATION_INPUT_BYTE_LIMITS,
  UNKNOWN_OPERATION_INPUT_MAX_BYTES,
  isOperationInputWithinBudget,
  operationContextSchema,
  operationInputSchemas,
  type OperationName,
} from "./operation-contracts.js";
import {
  hasGitSemanticStore,
  inspectGitSemanticStoreWorktree,
  materializeSemanticCacheFromWorktree,
  replaceGitSemanticStore,
} from "./git-semantic-store.js";
import { GitFacade } from "./git-facade.js";
import {
  TicketLedgerError,
  appendTicketReview,
  applyTicketWorktreePatch,
  loadTicketLedgerFromWorktree,
  recordTicketDecision,
  type TicketDecisionAuthorityContext,
  type TicketDecisionRecordResult,
  type TicketDecisionRecordRequest,
  type TicketDocument,
  type TicketLedgerPatchRequest,
  type TicketReviewAuthorContext,
  type TicketReviewAppendRequest,
  type TicketReviewSubject,
} from "./ticket-ledger/index.js";
import {
  InMemoryTicketDecisionSessionAttestationRegistryV0,
} from "./ticket-decision-attestation.js";
import {
  TicketReviewProjectionError,
} from "./ticket-review-projector.js";
import { TicketReviewReadServiceV0 } from "./ticket-review-read-service.js";
import {
  createTrustedTicketLedgerReviewProjectionSourceProviderV0,
  type ResolvedTicketReviewProjectionSourceProviderV0,
  type TicketReviewRepositoryScopeV0,
} from "./ticket-review-resolver.js";

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
  semantic_store_missing:5,
  semantic_authority_requires_dispatcher:5,
  invalid_snapshot:2, snapshot_expired:3, projection_too_large:4,
  projection_invariant_failed:1,
  ticket_ledger_missing:3, ticket_ledger_invalid_document:4,
  ticket_ledger_invalid_graph:4, ticket_ledger_unmerged:5,
  ticket_ledger_source_changed:5, ticket_ledger_ref_not_found:3,
  ticket_ledger_stale_source:5, ticket_ledger_stale_ticket:5,
  ticket_ledger_stale_subject:5, ticket_ledger_document_conflict:5,
  ticket_ledger_writer_busy:5, ticket_ledger_write_unverified:5,
  ticket_ledger_io:5, ticket_ledger_scope_mismatch:2,
  ticket_authority_unavailable:5, ticket_authority_scope_mismatch:5,
  ticket_attribution_mismatch:5,
};

interface Services {
  kb: KnowledgeService;
  distill: DistillationService;
  ticket: TicketReviewReadServiceV0;
}
type TicketDispatchScopeV0 = TicketReviewRepositoryScopeV0;
type Handler=(
  service: Services,
  ctx: OperationContext,
  input: Record<string, unknown>,
  ticketScope?: TicketDispatchScopeV0,
  dispatcherOptions?: OperationDispatcherOptions,
) => unknown;
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
  "kb.spec.apply":(s,c,i)=>s.kb.applySpecBatch(c.repoId,i as unknown as SpecBatchInput,mutation(c,true)),
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
  "ticket.graph.snapshot":(s,_c,i,scope)=>s.ticket.graphSnapshot(
    requiredTicketScope(scope),
    i,
  ),
  "ticket.subject.inspect":(s,_c,i,scope)=>s.ticket.subjectInspect(
    requiredTicketScope(scope),
    i,
  ),
  "ticket.trace.list":(s,_c,i,scope)=>s.ticket.traceList(
    requiredTicketScope(scope),
    i,
  ),
  "ticket.worktree.patch":(_s,_c,i,scope)=>applyTicketWorktreePatch({
    worktreeRoot:requiredTicketScope(scope).worktreeRoot,
    request:i as unknown as TicketLedgerPatchRequest,
  }),
  "ticket.review.append":(_s,c,i,scope,options)=>appendTicketReview({
    worktreeRoot:requiredTicketScope(scope).worktreeRoot,
    request:ticketReviewAppendRequest(i),
    author:ticketReviewAuthor(c,options),
    occurredAt:c.now,
  }),
  "ticket.decision.record":(_s,c,i,scope,options)=>recordTicketDecision({
    worktreeRoot:requiredTicketScope(scope).worktreeRoot,
    request:ticketDecisionRecordRequest(i),
    authority:ticketDecisionAuthority(c,i,options),
    decidedAt:c.now,
  }),
};

export interface TicketReviewHostAttribution {
  actorId: string;
  actorKind: "human" | "agent";
  attribution: "host_attested";
}

export type TicketDecisionAuthorityScope =
  | {
      decisionType: "plan_review";
      graphDigest: string;
    }
  | {
      decisionType: "protected_boundary";
      ticketId: string;
      ticketRevision: string;
      boundary: string;
    };

export interface TicketDecisionAuthorityGrant {
  authority: TicketDecisionAuthorityContext;
  scopes: readonly TicketDecisionAuthorityScope[];
}

export interface OperationDispatcherOptions {
  repoRoot?: string;
  ticketReviewProvider?: ResolvedTicketReviewProjectionSourceProviderV0;
  ticketReviewAttribution?: TicketReviewHostAttribution;
  ticketDecisionAuthority?: TicketDecisionAuthorityGrant;
}

export class OperationDispatcher {
  private readonly service:Services;
  private readonly ticketDecisionAttestations:
    InMemoryTicketDecisionSessionAttestationRegistryV0;
  constructor(
    private readonly db: Db,
    private readonly options: OperationDispatcherOptions = {},
  ) {
    this.ticketDecisionAttestations =
      new InMemoryTicketDecisionSessionAttestationRegistryV0();
    this.service = {
      kb: new KnowledgeService(db),
      distill: new DistillationService(db),
      ticket: new TicketReviewReadServiceV0(
        options.ticketReviewProvider
          ?? createTrustedTicketLedgerReviewProjectionSourceProviderV0(
            this.ticketDecisionAttestations,
          ),
      ),
    };
  }
  operations():string[]{return Object.keys(handlers).sort();}
  dispatch(operation:string,context:unknown,input:unknown={}):OperationResult{
    if(!isRegisteredOperation(operation)){
      return failure(unsupportedOperation(operation));
    }
    const address=receiptAddressSchema.safeParse(context);
    if(address.success){
      const raw=context as Record<string,unknown>;
      try{
        if(!isOperationInputWithinBudget(operation,input)){
          const maximumBytes = OPERATION_INPUT_BYTE_LIMITS[
            operation as keyof typeof OPERATION_INPUT_BYTE_LIMITS
          ] ?? UNKNOWN_OPERATION_INPUT_MAX_BYTES;
          throw new KnowledgeError(
            "validation_error",
            "operation input exceeds its safe JSON byte budget",
            {operation,maximumBytes},
            ["Reduce the input size or split it into bounded requests."],
          );
        }
        if(isReceiptlessGitTicketOperation(operation)){
          return this.invoke(operation,context,input);
        }
        const payloadHash=hashCanonical({
          actor:raw.actor??null,
          taskId:raw.taskId??null,
          input,
        });
        return this.dispatchRequest(
          operation,
          address.data.repoId,
          address.data.requestId,
          payloadHash,
          typeof raw.now==="string"?raw.now:"1970-01-01T00:00:00.000Z",
          ()=>this.invoke(operation,context,input),
        );
      }
      catch(error){return failure(error);}
    }
    try{return this.invoke(operation,context,input);}catch(error){return failure(error);}
  }
  private invoke(
    operation:string,
    context:unknown,
    input:unknown,
    resolvedTicketScope?: TicketDispatchScopeV0,
  ):OperationResult{
    const schema=operationInputSchemas[operation as OperationName];const handler=handlers[operation as OperationName];
    if(!schema||!handler)throw unsupportedOperation(operation);
    const parsedContext=operationContextSchema.safeParse(context);
    if(!parsedContext.success){
      const actorProbe=actorProbeSchema.safeParse(context);
      if(actorProbe.success&&(actorProbe.data.actor===undefined||(typeof actorProbe.data.actor==="string"&&!actorProbe.data.actor.trim())))throw new KnowledgeError("actor_required","actor is required",null,["Provide the calling human or agent identity."]);
      throw validation(parsedContext.error.issues,"context");
    }
    const parsedInput=schema.safeParse(input);if(!parsedInput.success)throw validation(parsedInput.error.issues,"input");
    const c=parsedContext.data as OperationContext;const normalizedInput=parsedInput.data as Record<string,unknown>;
    let data:unknown;
    if(operation.startsWith("kb.")&&this.gitSemanticRoot(c)){
      data=this.dispatchGitKnowledge(operation,c,normalizedInput,handler);
    }else if(DISTILL_MUTATIONS.has(operation)){
      data=this.dispatchDistillMutation(operation,c,normalizedInput,handler);
      if(operation==="distill.finalize"&&this.gitSemanticRoot(c))this.syncGitFeatureIdentities(c,data);
    }else{
      const ticketScope=requiresTicketScope(operation)
        ? resolvedTicketScope ?? this.resolveTicketScope()
        : undefined;
      data=handler(
        this.service,
        c,
        normalizedInput,
        ticketScope,
        this.options,
      );
      if(operation==="ticket.decision.record"&&ticketScope!==undefined){
        this.attestRecordedTicketDecision(
          ticketScope,
          data as TicketDecisionRecordResult,
        );
      }
    }
    return {ok:true,data,meta:{operation,repoId:c.repoId,requestId:c.requestId,at:c.now}};
  }
  private attestRecordedTicketDecision(
    scope:TicketDispatchScopeV0,
    result:TicketDecisionRecordResult,
  ):void {
    try{
      const snapshot=loadTicketLedgerFromWorktree(scope.worktreeRoot);
      this.ticketDecisionAttestations.attest(
        snapshot,
        result.decision,
      );
    }catch{
      // Session authority is a fail-closed operational capability. The durable
      // Decision write remains successful even if this host cannot attest its
      // exact post-write snapshot; subsequent reads expose it as unverified.
    }
  }
  private resolveTicketScope(): TicketDispatchScopeV0 {
    const candidate=this.options.repoRoot;
    if(!candidate){
      throw new KnowledgeError(
        "ticket_ledger_scope_mismatch",
        "Ticket operations require a trusted worktree path from the host adapter",
        null,
        ["Construct the dispatcher with the current trusted repoRoot."],
      );
    }
    try{
      const session=GitFacade.sessionContextAt(candidate);
      return {worktreeRoot:fs.realpathSync(session.toplevel)};
    }catch{
      throw new KnowledgeError(
        "ticket_ledger_scope_mismatch",
        "Ticket operation scope is not a readable Git worktree",
        {worktreeRoot:candidate},
        ["Use a readable Git checkout as repoRoot."],
      );
    }
  }
  private gitSemanticRoot(context:OperationContext):string|null{
    const repo=this.db.prepare(`SELECT root_path rootPath FROM repos WHERE id=?`).get(context.repoId) as {rootPath:string}|undefined;
    if(!repo)return null;
    const task=context.taskId?this.db.prepare(`SELECT worktree_path worktreePath FROM tasks WHERE id=? AND repo_id=?`).get(context.taskId,context.repoId) as {worktreePath:string|null}|undefined:undefined;
    let candidate=this.options.repoRoot??task?.worktreePath??repo.rootPath;
    if(this.options.repoRoot){
      const session=GitFacade.sessionContextAt(this.options.repoRoot);
      if(fs.realpathSync(session.repoRoot)!==fs.realpathSync(repo.rootPath)){
        throw new KnowledgeError("validation_error","dispatcher worktree does not belong to the addressed repository");
      }
      candidate=session.toplevel;
    }
    const authority=this.db.prepare(`SELECT format FROM repo_semantic_authority WHERE repo_id=?`).get(context.repoId) as {format:string}|undefined;
    if(hasGitSemanticStore(candidate)){
      const inspection=inspectGitSemanticStoreWorktree(candidate);
      this.db.prepare(`INSERT INTO repo_semantic_authority(repo_id,format,initial_semantic_digest,cutover_at) VALUES(?,'git-semantic-store',?,?) ON CONFLICT(repo_id) DO NOTHING`).run(
        context.repoId,inspection.semanticDigest,context.now,
      );
      return candidate;
    }
    if(authority){
      throw new KnowledgeError("semantic_store_missing","Git semantic authority is recorded but the current checkout has no semantic store",{repoId:context.repoId,checkout:candidate},["Switch to a commit containing .vibehub/semantic-store or restore the reviewed store before retrying."]);
    }
    return null;
  }
  private dispatchGitKnowledge(operation:string,c:OperationContext,input:Record<string,unknown>,handler:Handler){
    const repoRoot=this.gitSemanticRoot(c);
    if(!repoRoot)throw new KnowledgeError("internal_error","Git semantic authority disappeared during dispatch");
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vibehub-git-authority-"));
    const cachePath=path.join(temp,"semantic.db");
    let cache:Db|undefined;
    try{
      const materialized=materializeSemanticCacheFromWorktree({repoRoot,targetDbPath:cachePath});
      cache=openDb(cachePath);
      copyOperationalKnowledgeContext(this.db,c.repoId,cache,materialized.repoId);
      recoverDurableMutationReceipts(cache,materialized.repoId);
      const services={
        kb:new KnowledgeService(cache),
        distill:new DistillationService(cache),
        ticket:this.service.ticket,
      };
      const cacheContext={...c,repoId:materialized.repoId};
      const data=handler(services,cacheContext,input);
      if(GIT_KB_MUTATIONS.has(operation)){
        cache.close();cache=undefined;
        replaceGitSemanticStore({
          sourceDbPath:cachePath,
          sourceRepoId:materialized.repoId,
          repoRoot,
          expectedSemanticDigest:materialized.semanticDigest,
        });
        const receipts=openDb(cachePath);
        try{copyMutationReceipts(receipts,materialized.repoId,this.db,c.repoId);}
        finally{receipts.close();}
      }
      return data;
    }finally{
      cache?.close();
      fs.rmSync(temp,{recursive:true,force:true});
    }
  }
  private syncGitFeatureIdentities(c:OperationContext,result:unknown):void{
    const repoRoot=this.gitSemanticRoot(c);
    if(!repoRoot)throw new KnowledgeError("internal_error","Git semantic authority disappeared during feature finalization");
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vibehub-git-features-"));
    try{
      const cachePath=path.join(temp,"semantic.db");
      const materialized=materializeSemanticCacheFromWorktree({repoRoot,targetDbPath:cachePath});
      const cache=openDb(cachePath);
      let changed=false;
      try{
        const existing=new Set((cache.prepare(`SELECT feature_id id FROM kb_features WHERE repo_id=?`).all(materialized.repoId) as Array<{id:string}>).map(row=>row.id));
        const source=this.db.prepare(`SELECT feature_id id,created_at createdAt FROM kb_features WHERE repo_id=? ORDER BY feature_id`).all(c.repoId) as Array<{id:string;createdAt:string}>;
        const added=source.filter(row=>!existing.has(row.id));
        if(added.length){
          const insert=cache.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at) VALUES(?,?,?)`);
          for(const row of added)insert.run(materialized.repoId,row.id,row.createdAt);
          cache.prepare(`INSERT INTO kb_provenance_events(repo_id,operation,spec_id,actor,task_id,request_id,at,payload) VALUES(?,? ,NULL,?,?,?,?,?)`).run(
            materialized.repoId,"distill.finalize.features",c.actor,c.taskId??null,c.requestId,c.now,
            JSON.stringify({features:added.map(row=>row.id),result}),
          );
          changed=true;
        }
      }finally{cache.close();}
      if(!changed)return;
      replaceGitSemanticStore({
        sourceDbPath:cachePath,
        sourceRepoId:materialized.repoId,
        repoRoot,
        expectedSemanticDigest:materialized.semanticDigest,
      });
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }
  private dispatchRequest(
    operation:string,
    repoId:number,
    requestId:string,
    payloadHash:string,
    createdAt:string,
    invoke:()=>OperationResult,
  ){
    return this.db.transaction(()=>{
      const prior=this.readOperationReceipt(
        repoId,
        requestId,
        operation,
        payloadHash,
      );
      if(prior)return replayOperationReceipt(
        prior,
        operation,
        payloadHash,
        requestId,
      );
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
      this.insertOperationReceipt(
        operation,
        repoId,
        requestId,
        payloadHash,
        createdAt,
        outcome,
      );
      return outcome;
    }).immediate();
  }
  private readOperationReceipt(
    repoId:number,
    requestId:string,
    attemptedOperation:string,
    attemptedPayloadHash:string,
  ):OperationReceiptRow|undefined{
    const row=this.db.prepare(
      `SELECT r.repo_id repoId,r.request_id requestId,r.operation,
              r.payload_hash payloadHash,r.outcome_kind outcomeKind,
              r.outcome,r.created_at createdAt
       FROM operation_request_receipts r
       WHERE r.repo_id=? AND r.request_id=?`,
    ).get(repoId,requestId) as OperationReceiptRow|undefined;
    return row;
  }
  private insertOperationReceipt(
    operation:string,
    repoId:number,
    requestId:string,
    payloadHash:string,
    createdAt:string,
    outcome:OperationResult,
  ):void{
    this.db.prepare(
      `INSERT INTO operation_request_receipts(
         repo_id,request_id,operation,payload_hash,
         outcome_kind,outcome,created_at
       ) VALUES(?,?,?,?,?,?,?)`,
    ).run(
      repoId,
      requestId,
      operation,
      payloadHash,
      outcome.ok?"success":"error",
      JSON.stringify(outcome),
      createdAt,
    );
  }
  private dispatchDistillMutation(operation:string,c:OperationContext,input:Record<string,unknown>,handler:Handler){const stable=(value:unknown):string=>JSON.stringify(sortObject(value));const inputHash=crypto.createHash("sha256").update(stable({input,actor:c.actor,taskId:c.taskId??null})).digest("hex");return this.db.transaction(()=>{const prior=this.db.prepare(`SELECT input_hash inputHash,result FROM distill_mutation_receipts WHERE repo_id=? AND operation=? AND request_id=?`).get(c.repoId,operation,c.requestId) as {inputHash:string;result:string}|undefined;if(prior){if(prior.inputHash!==inputHash)throw new KnowledgeError("idempotency_conflict","requestId was reused with different mutation input",{operation,requestId:c.requestId},["Use a new requestId for a different mutation."]);return JSON.parse(prior.result);}const result=handler(this.service,c,input);this.db.prepare(`INSERT INTO distill_mutation_receipts(repo_id,operation,request_id,input_hash,result,created_at) VALUES(?,?,?,?,?,?)`).run(c.repoId,operation,c.requestId,inputHash,stable(result),c.now);return result;}).immediate();}
}

const DISTILL_MUTATIONS=new Set(["distill.run.start","distill.run.abort","distill.inventory.put","distill.inventory.seal","distill.scopes.plan","distill.scopes.claim","distill.scopes.complete","distill.scopes.fail","distill.scopes.retry","distill.scopes.correct","distill.candidates.put","distill.reconcile","distill.validate","distill.finalize","distill.activate","distill.rollback"]);
const GIT_KB_MUTATIONS=new Set(["kb.spec.apply","kb.mark-stale","kb.deprecate","kb.amend","kb.supersede"]);
interface OperationReceiptRow {
  repoId:number;
  requestId:string;
  operation:string;
  payloadHash:string;
  outcomeKind:"success"|"error";
  outcome:string;
  createdAt:string;
}
function replayOperationReceipt(
  prior:OperationReceiptRow,
  operation:string,
  payloadHash:string,
  requestId:string,
):OperationResult{
  if(prior.operation!==operation||prior.payloadHash!==payloadHash){
    throw new KnowledgeError(
      "idempotency_conflict",
      "requestId was reused with a different operation, actor, task, canonical input, or repository scope",
      {
        requestId,
        originalOperation:prior.operation,
        attemptedOperation:operation,
      },
      ["Use a new requestId for a different logical invocation."],
    );
  }
  return JSON.parse(prior.outcome) as OperationResult;
}
function sortObject(value:unknown):unknown{return Array.isArray(value)?value.map(sortObject):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,sortObject(v)])):value;}

function copyMutationReceipts(source:Db,sourceRepoId:number,target:Db,targetRepoId:number):void{
  const rows=source.prepare(`SELECT operation,idempotency_key idempotencyKey,input_hash inputHash,result,created_at createdAt FROM kb_mutation_receipts WHERE repo_id=?`).all(sourceRepoId) as Array<{operation:string;idempotencyKey:string;inputHash:string;result:string;createdAt:string}>;
  const insert=target.prepare(`INSERT INTO kb_mutation_receipts(repo_id,operation,idempotency_key,input_hash,result,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,operation,idempotency_key) DO NOTHING`);
  for(const row of rows)insert.run(targetRepoId,row.operation,row.idempotencyKey,row.inputHash,row.result,row.createdAt);
}

function recoverDurableMutationReceipts(db:Db,repoId:number):void{
  const rows=db.prepare(`SELECT payload FROM kb_provenance_events WHERE repo_id=? ORDER BY id`).all(repoId) as Array<{payload:string}>;
  const insert=db.prepare(`INSERT INTO kb_mutation_receipts(repo_id,operation,idempotency_key,input_hash,result,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(repo_id,operation,idempotency_key) DO NOTHING`);
  for(const row of rows){
    const payload=JSON.parse(row.payload) as { _receipt?: unknown };
    if(!payload._receipt||typeof payload._receipt!=="object"||Array.isArray(payload._receipt))continue;
    const receipt=payload._receipt as Record<string,unknown>;
    if(typeof receipt.operation!=="string"||typeof receipt.idempotencyKey!=="string"||
      typeof receipt.inputHash!=="string"||typeof receipt.createdAt!=="string"||
      receipt.result===undefined)throw new KnowledgeError("internal_error","durable mutation receipt is malformed");
    const result=JSON.stringify(receipt.result);
    insert.run(repoId,receipt.operation,receipt.idempotencyKey,receipt.inputHash,result,receipt.createdAt);
    const stored=db.prepare(`SELECT input_hash inputHash,result FROM kb_mutation_receipts WHERE repo_id=? AND operation=? AND idempotency_key=?`).get(repoId,receipt.operation,receipt.idempotencyKey) as {inputHash:string;result:string};
    if(stored.inputHash!==receipt.inputHash||
      hashCanonical(JSON.parse(stored.result))!==hashCanonical(receipt.result)){
      throw new KnowledgeError("idempotency_conflict","durable and operational mutation receipts disagree",{operation:receipt.operation,idempotencyKey:receipt.idempotencyKey});
    }
  }
}

function copyOperationalKnowledgeContext(source:Db,sourceRepoId:number,target:Db,targetRepoId:number):void{
  copyMutationReceipts(source,sourceRepoId,target,targetRepoId);
  const active=source.prepare(`SELECT a.version_id versionId,a.activated_at activatedAt,v.state,v.source_kind sourceKind,v.checksum,v.created_at createdAt,v.finalized_at finalizedAt FROM repo_active_mapping a JOIN mapping_versions v ON v.repo_id=a.repo_id AND v.version_id=a.version_id WHERE a.repo_id=?`).get(sourceRepoId) as {versionId:string;activatedAt:string;state:string;sourceKind:string;checksum:string;createdAt:string;finalizedAt:string|null}|undefined;
  if(!active)return;
  target.prepare(`INSERT INTO mapping_versions(repo_id,version_id,state,source_kind,checksum,created_at,finalized_at) VALUES(?,?,?,?,?,?,?)`).run(targetRepoId,active.versionId,active.state,active.sourceKind,active.checksum,active.createdAt,active.finalizedAt);
  const features=source.prepare(`SELECT feature_id featureId,parent_feature_id parentId,name,description,intent,lifecycle FROM mapping_version_features WHERE repo_id=? AND version_id=?`).all(sourceRepoId,active.versionId) as Array<{featureId:string;parentId:string|null;name:string;description:string|null;intent:string|null;lifecycle:string}>;
  const pending=new Map(features.map(row=>[row.featureId,row]));
  const inserted=new Set<string>();
  const insertFeature=target.prepare(`INSERT INTO mapping_version_features(repo_id,version_id,feature_id,parent_feature_id,name,description,intent,lifecycle) VALUES(?,?,?,?,?,?,?,?)`);
  while(pending.size){
    let progress=false;
    for(const [id,row] of pending){
      if(row.parentId!==null&&!inserted.has(row.parentId))continue;
      insertFeature.run(targetRepoId,active.versionId,id,row.parentId,row.name,row.description,row.intent,row.lifecycle);
      pending.delete(id);inserted.add(id);progress=true;
    }
    if(!progress)throw new KnowledgeError("internal_error","active mapping feature hierarchy is cyclic or incomplete");
  }
  const anchors=source.prepare(`SELECT feature_id featureId,file,symbol,line_start lineStart,line_end lineEnd,content_hash contentHash FROM mapping_version_anchors WHERE repo_id=? AND version_id=?`).all(sourceRepoId,active.versionId) as Array<{featureId:string;file:string;symbol:string;lineStart:number|null;lineEnd:number|null;contentHash:string|null}>;
  const insertAnchor=target.prepare(`INSERT INTO mapping_version_anchors(repo_id,version_id,feature_id,file,symbol,line_start,line_end,content_hash) VALUES(?,?,?,?,?,?,?,?)`);
  for(const row of anchors)insertAnchor.run(targetRepoId,active.versionId,row.featureId,row.file,row.symbol,row.lineStart,row.lineEnd,row.contentHash);
  target.prepare(`INSERT INTO repo_active_mapping(repo_id,version_id,activated_at) VALUES(?,?,?)`).run(targetRepoId,active.versionId,active.activatedAt);
}

const actorProbeSchema=z.object({actor:z.unknown().optional()}).passthrough();
const receiptAddressSchema=z.object({repoId:operationContextSchema.shape.repoId,requestId:operationContextSchema.shape.requestId}).passthrough();
function hashCanonical(value:unknown){return crypto.createHash("sha256").update(JSON.stringify(sortObject(value))).digest("hex");}
function failure(error:unknown):OperationResult{const e=normalize(error);return {ok:false,error:{code:e.code,message:e.message,details:e.details,nextSafeActions:e.nextSafeActions}};}
function isRegisteredOperation(operation:string):operation is OperationName{
  return Object.hasOwn(operationInputSchemas,operation)
    &&Object.hasOwn(handlers,operation);
}
function unsupportedOperation(operation:string):KnowledgeError{
  return new KnowledgeError(
    "unsupported_operation",
    `unsupported operation: ${operation}`,
    {operation},
    ["List dispatcher operations and choose a registered operation."],
  );
}

function mutation(c:OperationContext,taskRequired:boolean){if(taskRequired&&!c.taskId?.trim())throw new KnowledgeError("task_required","taskId is required for active Spec batch apply",null,["Associate the write with the current task."]);return {actor:c.actor,taskId:c.taskId,requestId:c.requestId,now:c.now};}
function req(v:unknown,name:string){if(typeof v!=="string"||!v.trim())throw new KnowledgeError("validation_error",`${name} is required`,{field:name});return v;}
function normalize(error:unknown):KnowledgeError{
  if(error instanceof KnowledgeError)return error;
  if(error instanceof TicketReviewProjectionError){
    return new KnowledgeError(
      error.code,
      error.message,
      error.details,
      ticketReviewNextSafeActions(error.code),
    );
  }
  if(error instanceof TicketLedgerError){
    const code = error.code === "ledger_missing"
      ? "ticket_ledger_missing"
      : error.code === "source_changed_during_read"
        ? "ticket_ledger_source_changed"
        : error.code === "stale_source"
          ? "ticket_ledger_stale_source"
          : error.code === "stale_ticket_revision"
            ? "ticket_ledger_stale_ticket"
            : error.code === "stale_subject"
              ? "ticket_ledger_stale_subject"
              : error.code === "document_conflict"
                ? "ticket_ledger_document_conflict"
            : error.code === "writer_busy"
              ? "ticket_ledger_writer_busy"
              : error.code === "write_verification_failed"
                ? "ticket_ledger_write_unverified"
        : error.code === "ref_not_found"
          ? "ticket_ledger_ref_not_found"
          : error.code === "invalid_document"
            || error.code === "invalid_path"
            || error.code === "file_too_large"
            || error.code === "ledger_too_large"
            || error.code === "unsupported_file"
            || error.code === "symlink"
            || error.code === "duplicate_change"
            ? "ticket_ledger_invalid_document"
            : error.code === "invalid_graph"
              ? "ticket_ledger_invalid_graph"
              : error.code === "unmerged"
                ? "ticket_ledger_unmerged"
                : "ticket_ledger_io";
    const nextSafeActions = error.code === "writer_busy"
      ? [
          "Wait for the active Ticket writer to finish; if it crashed, verify no writer is running before removing the reported worktree lock.",
        ]
      : error.code === "write_verification_failed"
        ? [
            "Inspect `git diff -- .vibehub/tickets` and the reported paths before rebuilding a patch from a fresh snapshot.",
          ]
      : error.code === "stale_source"
          || error.code === "stale_ticket_revision"
          || error.code === "stale_subject"
          ? [
              "Refresh ticket.graph.snapshot, rebuild the exact patch, and retry.",
            ]
          : error.code === "document_conflict"
            ? [
                "Inspect the existing Git-native review or Decision document; do not overwrite a conflicting exact subject.",
              ]
          : [
              "Inspect and repair `.vibehub/tickets`, then retry the read.",
            ];
    return new KnowledgeError(
      code,
      error.message,
      error.details,
      nextSafeActions,
    );
  }
  const message=error instanceof Error?error.message:String(error);
  if(message.includes("FOREIGN KEY"))return new KnowledgeError("not_found","referenced entity does not exist",{cause:message});
  if(message.includes("UNIQUE"))return new KnowledgeError("already_exists","entity already exists",{cause:message});
  return new KnowledgeError("internal_error","knowledge operation failed",{cause:message},["Retry after inspecting database health."]);
}
function validation(issues:readonly {path:PropertyKey[];message:string;code:string}[],scope:string){return new KnowledgeError("validation_error",`invalid ${scope}`,{issues:issues.map(x=>({path:x.path.map(String),message:x.message,code:x.code}))},["Correct the malformed request and retry."]);}
function requiresTicketScope(operation:string):operation is
  | "ticket.graph.snapshot"
  | "ticket.subject.inspect"
  | "ticket.trace.list"
  | "ticket.worktree.patch"
  | "ticket.review.append"
  | "ticket.decision.record"
{
  return operation==="ticket.graph.snapshot"
    || operation==="ticket.subject.inspect"
    || operation==="ticket.trace.list"
    || operation==="ticket.worktree.patch"
    || operation==="ticket.review.append"
    || operation==="ticket.decision.record";
}
function isReceiptlessGitTicketOperation(operation:string):operation is
  | "ticket.graph.snapshot"
  | "ticket.subject.inspect"
  | "ticket.trace.list"
  | "ticket.worktree.patch"
  | "ticket.review.append"
  | "ticket.decision.record" {
  return operation==="ticket.graph.snapshot"
    || operation==="ticket.subject.inspect"
    || operation==="ticket.trace.list"
    || operation==="ticket.worktree.patch"
    || operation==="ticket.review.append"
    || operation==="ticket.decision.record";
}
function requiredTicketScope(
  scope:TicketDispatchScopeV0|undefined,
):TicketDispatchScopeV0 {
  if(scope)return scope;
  throw new KnowledgeError(
    "internal_error",
    "Ticket operation reached its handler without a verified repository scope",
  );
}

type PublicTicketMutationSubject =
  | {kind:"graph";graphDigest:string}
  | {kind:"ticket";ticketId:string;ticketRevision:string}
  | {
      kind:"relation";
      relationRef:string;
      prerequisiteTicketId:string;
      dependentTicketId:string;
      dependentTicketRevision:string;
    };

const rawSha256 = (value:string):string => value.slice("sha256:".length);

function durableTicketMutationSubject(
  value:unknown,
):TicketReviewSubject {
  const subject=value as PublicTicketMutationSubject;
  if(subject.kind==="graph"){
    return {kind:"graph",graph_digest:rawSha256(subject.graphDigest)};
  }
  if(subject.kind==="ticket"){
    return {
      kind:"ticket",
      ticket_id:subject.ticketId,
      ticket_revision:rawSha256(subject.ticketRevision),
    };
  }
  return {
    kind:"relation",
    relation_ref:subject.relationRef,
    prerequisite_ticket_id:subject.prerequisiteTicketId,
    dependent_ticket_id:subject.dependentTicketId,
    dependent_ticket_revision:rawSha256(subject.dependentTicketRevision),
  };
}

function ticketReviewAppendRequest(
  input:Record<string,unknown>,
):TicketReviewAppendRequest {
  const review=input.review as {
    type:"comment"|"ticket_edit";
    subject:PublicTicketMutationSubject;
    body:string;
    replacementTicket?:TicketDocument;
    rationale?:string;
  };
  const subject=durableTicketMutationSubject(review.subject);
  return {
    expectedSource:input.expectedSource as TicketLedgerPatchRequest["expectedSource"],
    review:review.type==="comment"
      ? {
          review_type:"comment",
          subject,
          body:review.body,
        }
      : {
          review_type:"ticket_edit",
          subject,
          body:review.body,
          replacement_ticket:review.replacementTicket!,
          rationale:review.rationale!,
        },
  };
}

function ticketDecisionRecordRequest(
  input:Record<string,unknown>,
):TicketDecisionRecordRequest {
  const decision=input.decision as {
    type:"plan_review"|"protected_boundary";
    subject:PublicTicketMutationSubject;
    disposition:
      |"approve_execution"
      |"delegate_within_boundaries"
      |"request_changes"
      |"resolve"
      |"decline";
    delegatedBoundaries?:string[];
    boundary?:string;
    selection?:string;
    rationale:string;
    resolutionRefs:string[];
  };
  const subject=durableTicketMutationSubject(decision.subject);
  return {
    expectedSource:input.expectedSource as TicketLedgerPatchRequest["expectedSource"],
    decision:decision.type==="plan_review"
      ? {
          decision_type:"plan_review",
          subject,
          disposition:decision.disposition as
            |"approve_execution"
            |"delegate_within_boundaries"
            |"request_changes",
          ...(decision.delegatedBoundaries===undefined
            ?{}
            :{delegated_boundaries:decision.delegatedBoundaries}),
          rationale:decision.rationale,
          resolution_refs:decision.resolutionRefs,
        }
      : {
          decision_type:"protected_boundary",
          subject,
          boundary:decision.boundary!,
          disposition:decision.disposition as "resolve"|"decline",
          ...(decision.selection===undefined
            ?{}
            :{selection:decision.selection}),
          rationale:decision.rationale,
          resolution_refs:decision.resolutionRefs,
        },
  } as TicketDecisionRecordRequest;
}

function ticketReviewAuthor(
  context:OperationContext,
  options:OperationDispatcherOptions|undefined,
):TicketReviewAuthorContext {
  const attribution=options?.ticketReviewAttribution;
  if(attribution===undefined){
    return {
      actor_id:context.actor,
      actor_kind:"agent",
      attribution:"claimed",
    };
  }
  if(attribution.actorId!==context.actor){
    throw new KnowledgeError(
      "ticket_attribution_mismatch",
      "Trusted Ticket review attribution does not match the operation actor",
      {actor:context.actor,attributedActor:attribution.actorId},
      ["Restart the review host with one matching trusted reviewer identity."],
    );
  }
  return {
    actor_id:attribution.actorId,
    actor_kind:attribution.actorKind,
    attribution:attribution.attribution,
  };
}

function ticketDecisionAuthority(
  context:OperationContext,
  input:Record<string,unknown>,
  options:OperationDispatcherOptions|undefined,
):TicketDecisionAuthorityContext {
  const grant=options?.ticketDecisionAuthority;
  if(grant===undefined){
    throw new KnowledgeError(
      "ticket_authority_unavailable",
      "Ticket Decisions require a trusted host-bound human authority grant",
      null,
      ["Use a trusted review host configured for this exact Decision subject."],
    );
  }
  if(grant.authority.principal_id!==context.actor){
    throw new KnowledgeError(
      "ticket_authority_scope_mismatch",
      "Ticket Decision actor does not match the trusted human principal",
      {
        actor:context.actor,
        principalId:grant.authority.principal_id,
      },
      ["Restart the review host under the matching trusted human principal."],
    );
  }
  const decision=input.decision as {
    type:"plan_review"|"protected_boundary";
    subject:PublicTicketMutationSubject;
    boundary?:string;
  };
  const matched=grant.scopes.some((scope)=>{
    if(
      decision.type==="plan_review"
      &&scope.decisionType==="plan_review"
      &&decision.subject.kind==="graph"
    ){
      return scope.graphDigest===decision.subject.graphDigest;
    }
    return decision.type==="protected_boundary"
      &&scope.decisionType==="protected_boundary"
      &&decision.subject.kind==="ticket"
      &&scope.ticketId===decision.subject.ticketId
      &&scope.ticketRevision===decision.subject.ticketRevision
      &&scope.boundary===decision.boundary;
  });
  if(!matched){
    throw new KnowledgeError(
      "ticket_authority_scope_mismatch",
      "Trusted human authority does not cover this exact Ticket Decision",
      {
        decisionType:decision.type,
        subject:decision.subject,
        boundary:decision.boundary??null,
      },
      ["Use a review host grant bound to this exact graph or protected boundary."],
    );
  }
  return grant.authority;
}

function ticketReviewNextSafeActions(code:string):string[]{
  if(code==="validation_error"||code==="invalid_snapshot"){
    return ["Correct the Ticket selector or restart from ticket.graph.snapshot."];
  }
  if(code==="not_found"){
    return ["Initialize `.vibehub/tickets/protocol.yaml`; a protocol-only empty graph is valid."];
  }
  if(code==="snapshot_expired"){
    return ["Refresh ticket.graph.snapshot and retry against its new snapshotId."];
  }
  if(code==="projection_too_large"){
    return ["Reduce the Ticket ledger below the declared review capacity."];
  }
  return ["Inspect and repair the Git-native Ticket documents in this worktree."];
}
