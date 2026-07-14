import { z } from "zod";
import { KB_RELATION_TYPES, KB_SPEC_STATES, KB_SPEC_TYPES } from "./contract/kb-types.js";

// Public operation strings are canonical values, not normalization requests.
// The absolute-end guard prevents JavaScript's `$` from accepting a final newline.
const boundedString = (maxLength:number) => z.string()
  .check(z.custom<string>(value=>typeof value==="string"&&[...value].length<=maxLength,{message:`must contain at most ${maxLength} Unicode characters`}))
  .meta({maxLength});
const canonicalString = (maxLength:number) => boundedString(maxLength).min(1).regex(/^(?!\s)[\s\S]*\S$(?![\s\S])/);
const id = canonicalString(200);
const path = boundedString(1000).min(1).regex(/^(?!\s)(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\\)(?!.*\/$)[\s\S]*\S$(?![\s\S])/);
const short = canonicalString(300);
const long = boundedString(20_000);
const tags = z.array(canonicalString(100)).max(50);
const specType = z.enum(KB_SPEC_TYPES);
const specState = z.enum(KB_SPEC_STATES);
const relationType = z.enum(KB_RELATION_TYPES);

export const operationContextSchema = z.object({
  repoId: z.number().int().positive(), actor: id, taskId: id.optional(), requestId: id,
  now: z.iso.datetime({offset:true}),
}).strict();

export const evidenceSchema = z.object({
  id: id.optional(), sourceType: id, sourceRef: canonicalString(2000),
  exactQuote: long.optional(), evidenceRef: canonicalString(2000).optional(),
  contentHash: canonicalString(200).optional(), confidence: z.number().min(0).max(1).optional(),
}).strict().refine(x=>x.exactQuote!==undefined||x.evidenceRef!==undefined||x.contentHash!==undefined,{message:"evidence requires exactQuote, evidenceRef, or contentHash"});
export const anchorSchema = z.object({file:path,symbol:boundedString(500).optional(),lineStart:z.number().int().positive().optional(),lineEnd:z.number().int().positive().optional(),contentHash:canonicalString(200).optional()}).strict()
  .refine(x=>x.lineEnd===undefined||(x.lineStart!==undefined&&x.lineEnd>=x.lineStart),{message:"lineEnd requires lineStart and must not precede it"});
const relationSchema=z.object({toSpecId:id,type:relationType,rationale:long.optional()}).strict();
const draftSchema=z.object({id,featureId:id.optional(),type:specType,summary:short,detail:long.optional(),priority:id.optional(),layer:id.optional(),domain:id.optional(),tags:tags.optional(),evidence:z.array(evidenceSchema).min(1).max(50),anchors:z.array(anchorSchema).max(100).optional(),relations:z.array(relationSchema).max(100).optional()}).strict();
const key=canonicalString(200);
const mutationBase={specId:id,idempotencyKey:key};
const runId=id;
const distillRun=z.object({runId}).strict();
const exclusionReason=z.enum(["generated_or_dependency","binary_file","oversize_file","non_regular_file","incremental_unchanged","incremental_deleted"]);
const inventoryRow=z.object({path,classification:z.enum(["included","excluded"]),reason:exclusionReason.optional(),contentHash:id.optional(),changeKind:z.enum(["added","modified","renamed","deleted","unchanged"]).optional(),previousPath:path.optional()}).strict()
  .refine(x=>x.classification==="included"?Boolean(x.contentHash):Boolean(x.reason),{message:"included row requires contentHash; excluded row requires reason"})
  .refine(x=>x.classification==="included"?x.reason===undefined:true,{message:"included row must not carry an exclusion reason"})
  .refine(x=>!x.changeKind||x.changeKind==="deleted"||Boolean(x.contentHash),{message:"incremental non-deleted row requires target contentHash"})
  .refine(x=>x.changeKind==="deleted"?x.classification==="excluded"&&x.reason==="incremental_deleted":x.reason!=="incremental_deleted",{message:"deleted rows require incremental_deleted exclusion"})
  .refine(x=>x.changeKind==="unchanged"?x.classification==="excluded"&&(x.reason==="incremental_unchanged"||x.reason==="non_regular_file"):x.reason!=="incremental_unchanged",{message:"unchanged rows require incremental_unchanged or non_regular_file exclusion"});
const scopePlan=z.object({scopeId:id,parentScopeId:id.nullable(),kind:z.enum(["analysis","leaf"]),files:z.array(path).max(10_000)}).strict();
const lease=z.object({runId,scopeId:id,leaseToken:id,generation:z.number().int().positive()}).strict();
const candidateEvidence=z.object({sourceRef:canonicalString(2000),exactQuote:long.optional(),evidenceRef:canonicalString(2000).optional(),contentHash:id.optional(),confidence:z.number().min(0).max(1).optional()}).strict()
  .refine(x=>x.exactQuote!==undefined||x.evidenceRef!==undefined||x.contentHash!==undefined,{message:"candidate evidence requires content"});
const unresolvedDisposition=z.object({path,reason:short,evidence:z.array(candidateEvidence).max(20).optional()}).strict();
const scopeComplete=z.object({...lease.shape,coveredFiles:z.array(path).max(10_000),unresolvedFiles:z.array(unresolvedDisposition).max(10_000).optional()}).strict()
  .refine(x=>new TextEncoder().encode(JSON.stringify(x)).byteLength<=1_048_576,{message:"scope completion payload must not exceed 1 MiB"})
  .refine(x=>(x.unresolvedFiles??[]).reduce((count,item)=>count+(item.evidence?.length??0),0)<=200,{message:"scope completion may contain at most 200 evidence entries"});
const candidateBase={runId,naturalId:id,sourceScopeId:id,leaseToken:id,generation:z.number().int().positive(),action:z.enum(["upsert","remove"]).optional(),evidence:z.array(candidateEvidence).min(1).max(100),supersedesHash:id.optional()};
const featureCandidate=z.object({...candidateBase,kind:z.literal("feature"),payload:z.object({name:short,parentId:id.nullable().optional(),description:long.optional(),intent:long.optional()}).strict()}).strict();
const specCandidate=z.object({...candidateBase,kind:z.literal("spec"),payload:z.object({type:specType,summary:short,detail:long.optional(),priority:id.optional(),layer:id.optional(),domain:id.optional(),tags:tags.optional()}).strict()}).strict();
const candidateAnchor=anchorSchema.safeExtend({featureId:id,contentHash:id}).strict();
const anchorCandidate=z.object({...candidateBase,kind:z.literal("anchor"),payload:candidateAnchor}).strict();
const relationCandidate=z.object({...candidateBase,kind:z.literal("relation"),payload:z.object({fromKind:z.literal("spec"),fromId:id,toKind:z.literal("spec"),toId:id,type:relationType,rationale:long.optional()}).strict().refine(x=>x.fromId!==x.toId,{message:"relation endpoints must differ"})}).strict();

export const operationInputSchemas = {
  "kb.status": z.object({}).strict(),
  "kb.feature.list": z.object({query:short.optional(),path:path.optional(),limit:z.number().int().min(1).max(200).optional(),offset:z.number().int().min(0).max(100_000).optional()}).strict(),
  "kb.feature.get": z.object({id}).strict(),
  "kb.feature.suggest": z.object({query:short.optional(),path:path.optional(),limit:z.number().int().min(1).max(50).optional(),offset:z.number().int().min(0).max(100_000).optional()}).strict(),
  "kb.spec.search": z.object({query:short.optional(),paths:z.array(path).max(50).optional(),types:z.array(specType).max(7).optional(),states:z.array(specState).max(5).optional(),tags:tags.optional(),domain:id.optional(),layer:id.optional(),includeDrafts:z.boolean().optional(),includeHistory:z.boolean().optional(),limit:z.number().int().min(1).max(200).optional(),offset:z.number().int().min(0).max(100_000).optional()}).strict(),
  "kb.spec.get": z.object({id}).strict(),
  "kb.relations": z.object({specId:id,direction:z.enum(["out","in","both"]).optional(),types:z.array(relationType).max(4).optional(),depth:z.number().int().min(1).max(5).optional(),limit:z.number().int().min(1).max(500).optional()}).strict(),
  "kb.lineage": z.object({id,maxDepth:z.number().int().min(1).max(100).optional()}).strict(),
  "kb.anchors": z.union([z.object({specId:id}).strict(),z.object({path}).strict()]),
  "kb.review": z.object({kinds:z.array(z.enum(["low_confidence","conflict","stale","unplaced"])).max(4).optional(),limit:z.number().int().min(1).max(500).optional(),offset:z.number().int().min(0).max(100_000).optional()}).strict(),
  "kb.ingest.preview": z.object({specs:z.array(z.object({summary:short,anchors:z.array(anchorSchema).max(100).optional()}).strict()).min(1).max(100)}).strict(),
  "kb.draft.apply": z.object({idempotencyKey:key,specs:z.array(draftSchema).min(1).max(100)}).strict(),
  "kb.promote": z.object(mutationBase).strict(),
  "kb.mark-stale": z.object(mutationBase).strict(),
  "kb.deprecate": z.object(mutationBase).strict(),
  "kb.amend": z.object({...mutationBase,type:specType.optional(),summary:short.optional(),detail:long.nullable().optional(),priority:id.nullable().optional(),layer:id.nullable().optional(),domain:id.nullable().optional(),tags:tags.optional(),featureId:id.nullable().optional(),evidence:z.array(evidenceSchema).min(1).max(50),anchors:z.array(anchorSchema).max(100).optional()}).strict(),
  "kb.supersede": z.object({...mutationBase,replacementSpecId:id,promoteReplacement:z.boolean().optional(),rationale:long.optional()}).strict(),
  "distill.run.start": z.object({runId,mode:z.enum(["cold","refresh","incremental"]),baseCommit:z.string().regex(/^[0-9a-f]{40}$/),skillHash:id,configHash:id,budget:z.record(z.string(),z.unknown()).optional()}).strict(),
  "distill.run.status": distillRun,
  "distill.run.resume": distillRun,
  "distill.run.abort": z.object({runId,reason:short}).strict(),
  "distill.inventory.put": z.object({runId,rows:z.array(inventoryRow).min(1).max(10_000)}).strict(),
  "distill.inventory.get": distillRun,
  "distill.inventory.diff": z.object({runId,paths:z.array(path).max(10_000)}).strict(),
  "distill.inventory.seal": distillRun,
  "distill.scopes.plan": z.object({runId,scopes:z.array(scopePlan).min(1).max(2_000)}).strict(),
  "distill.scopes.claim": z.object({runId,workerId:id,leaseSeconds:z.number().int().min(1).max(86_400)}).strict(),
  "distill.scopes.complete": scopeComplete,
  "distill.scopes.fail": z.object({...lease.shape,reason:short,coveredFiles:z.array(path).max(10_000).optional()}).strict(),
  "distill.scopes.retry": z.object({runId,scopeId:id,reason:short}).strict(),
  "distill.scopes.correct": z.object({runId,scopeIds:z.array(id).min(1).max(2_000),reason:short}).strict(),
  "distill.candidates.put": z.discriminatedUnion("kind",[featureCandidate,specCandidate,anchorCandidate,relationCandidate]),
  "distill.candidates.get": z.object({runId:runId.optional(),versionId:id.optional(),kind:z.enum(["feature","spec","anchor","relation"]),naturalId:id,revisionHash:id.optional()}).strict().refine(x=>(x.runId?1:0)+(x.versionId?1:0)===1,{message:"exactly one of runId or versionId is required"}),
  "distill.candidates.list": z.object({runId:runId.optional(),versionId:id.optional(),kind:z.enum(["feature","spec","anchor","relation"]).optional(),limit:z.number().int().min(1).max(500).optional(),offset:z.number().int().min(0).max(100_000).optional()}).strict().refine(x=>(x.runId?1:0)+(x.versionId?1:0)===1,{message:"exactly one of runId or versionId is required"}),
  "distill.baseline.get": z.object({selector:z.literal("active")}).strict(),
  "distill.version.get": z.object({versionId:id}).strict(),
  "distill.version.diff": z.object({versionId:id,kinds:z.array(z.enum(["feature","spec","anchor"])).max(3).optional()}).strict(),
  "distill.reconcile": distillRun,
  "distill.validate": distillRun,
  "distill.finalize": distillRun,
  "distill.activate": z.object({targetVersionId:id,expectedCurrentVersion:id.nullable(),reason:short}).strict(),
  "distill.rollback": z.object({targetVersionId:id,expectedCurrentVersion:id.nullable(),reason:short}).strict(),
} as const;

/**
 * Audited cross-field rules that Zod's JSON Schema conversion cannot preserve
 * by itself. `runtimeSites` must equal the number of `.refine` calls owning the
 * rule in this file; the contract generator checks the aggregate against the
 * source before publishing the artifact.
 */
export const operationRefinementManifest = {
  "evidence-content": {runtimeSites:1,operations:["kb.draft.apply","kb.amend"]},
  "anchor-line-range": {runtimeSites:1,operations:["kb.ingest.preview","kb.draft.apply","kb.amend","distill.candidates.put"]},
  "inventory-classification": {runtimeSites:1,operations:["distill.inventory.put"]},
  "inventory-included-no-reason": {runtimeSites:1,operations:["distill.inventory.put"]},
  "inventory-change-hash": {runtimeSites:1,operations:["distill.inventory.put"]},
  "inventory-deleted-reason": {runtimeSites:1,operations:["distill.inventory.put"]},
  "inventory-unchanged-reason": {runtimeSites:1,operations:["distill.inventory.put"]},
  "scope-completion-byte-budget": {runtimeSites:1,operations:["distill.scopes.complete"]},
  "scope-completion-evidence-budget": {runtimeSites:1,operations:["distill.scopes.complete"]},
  "candidate-evidence-content": {runtimeSites:1,operations:["distill.candidates.put"]},
  "relation-distinct-endpoints": {runtimeSites:1,operations:["distill.candidates.put"]},
  "candidate-selector-exactly-one": {runtimeSites:2,operations:["distill.candidates.get","distill.candidates.list"]},
  "candidate-discriminated-union": {runtimeSites:0,operations:["distill.candidates.put"]},
  "anchors-strict-union": {runtimeSites:0,operations:["kb.anchors"]},
} as const;

/**
 * Source-level acceptance constructs. The generator counts every site before
 * publishing so a new transform, format, union, regex, or unknown-value escape
 * cannot silently change the packaged contract's accepted language.
 */
export const operationAcceptanceConstructManifest = {
  trim: 0,
  transform: 0,
  preprocess: 0,
  pipe: 0,
  default: 0,
  catch: 0,
  coerce: 0,
  regex: 3,
  isoDatetime: 1,
  union: 1,
  discriminatedUnion: 1,
  unknown: 1,
  strict: 55,
  safeExtend: 1,
  optional: 90,
  nullable: 9,
  check: 1,
  custom: 1,
  meta: 1,
  overwrite: 0,
  normalize: 0,
  lowercase: 0,
  uppercase: 0,
  nonempty: 0,
  length: 0,
  any: 0,
} as const;

export type OperationName=keyof typeof operationInputSchemas;
