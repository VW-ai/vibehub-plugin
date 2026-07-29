import { z } from "zod";
import { KB_RELATION_TYPES, KB_SPEC_STATES, KB_SPEC_TYPES } from "./contract/kb-types.js";
import {
  TICKET_PROPOSAL_AUTHORITY_SIGNALS,
  TICKET_PROPOSAL_CHANGE_CLASSES,
  TICKET_PROPOSAL_MAX_CHANGES,
  TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE,
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_MAX_PAGE_SIZE,
  TICKET_PROPOSAL_SCHEMA_VERSION,
  TICKET_PROPOSAL_VALIDATION_CHECK_CODES,
  TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_MAX_PAGE_SIZE,
  TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION,
  isJsonValueWithinByteBudgetV0,
  isTicketProposalInputWithinBudgetV0,
} from "./contract/ticket-proposal.js";
import {
  TICKET_REVIEW_MAX_PAGE_SIZE,
  TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE,
  TICKET_REVIEW_TRACE_KINDS,
} from "./contract/ticket-review.js";

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
const ticketOpaqueRef = canonicalString(300);
const ticketId = canonicalString(200);
const ticketSnapshotId = z.string().regex(/^tgs-[0-9a-f]{64}$/);
const ticketProposalId = z.string().regex(/^tgp-[0-9a-f]{64}$/);
const ticketProposalValidationReceiptId = z.string()
  .regex(/^tpv-[0-9a-f]{64}$/);
const sha256Digest = z.string().regex(/^[0-9a-f]{64}$/);
const ticketDefinitionRevision = z.number().int().positive()
  .max(9_999_999_999);
const ticketReviewSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), ticketId }).strict(),
  z.object({ kind: z.literal("relation"), relationRef: ticketOpaqueRef }).strict(),
]);
const ticketTraceKinds = z.array(z.enum(TICKET_REVIEW_TRACE_KINDS))
  .max(TICKET_REVIEW_TRACE_KINDS.length)
  .refine((kinds) => new Set(kinds).size === kinds.length, {
    message: "trace kinds must be unique",
  });
const ticketProposalSource = z.object({
  kind: z.enum(["ticket", "run", "plan", "conversation", "other"]),
  ref: canonicalString(300),
}).strict();
const ticketProposalExactSubject = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ticket"),
    ticketId,
    definitionRevision: ticketDefinitionRevision,
  }).strict(),
  z.object({
    kind: z.literal("relation"),
    relationRef: ticketOpaqueRef,
    prerequisiteTicketId: ticketId,
    dependentTicketId: ticketId,
  }).strict(),
]);
const ticketProposalDefinitionRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), ticketId }).strict(),
  z.object({ kind: z.literal("local"), localRef: id }).strict(),
]);
const ticketProposalDependency = z.object({
  target: ticketProposalDefinitionRef,
  rationale: boundedString(20_000).optional(),
}).strict();
const ticketProposalDefinitionBody = z.object({
  outcome: canonicalString(20_000),
  parent: ticketProposalDefinitionRef.nullable(),
  dependsOn: z.array(ticketProposalDependency)
    .max(TICKET_PROPOSAL_MAX_DEPENDENCIES_PER_CHANGE),
}).strict();
const ticketProposalGraphChange = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    localRef: id,
    definition: ticketProposalDefinitionBody,
  }).strict(),
  z.object({
    op: z.literal("revise"),
    ticketId,
    expectedDefinitionRevision: ticketDefinitionRevision,
    replacement: ticketProposalDefinitionBody,
  }).strict(),
]);
const ticketProposalAuthorAssessment = z.object({
  changeClass: z.enum(TICKET_PROPOSAL_CHANGE_CLASSES),
  authoritySignals: z.array(z.enum(TICKET_PROPOSAL_AUTHORITY_SIGNALS))
    .max(TICKET_PROPOSAL_AUTHORITY_SIGNALS.length)
    .refine((signals) => new Set(signals).size === signals.length, {
      message: "authority signals must be unique",
    }),
  introducesHumanGate: z.boolean(),
  rationale: canonicalString(20_000),
}).strict();
const ticketProposalSubmit = z.discriminatedUnion("kind", [
  z.object({
    schemaVersion: z.literal(TICKET_PROPOSAL_SCHEMA_VERSION),
    kind: z.literal("comment"),
    observedSnapshotId: ticketSnapshotId,
    subject: ticketProposalExactSubject,
    body: canonicalString(20_000),
  }).strict(),
  z.object({
    schemaVersion: z.literal(TICKET_PROPOSAL_SCHEMA_VERSION),
    kind: z.literal("graph_change"),
    observedSnapshotId: ticketSnapshotId.nullable(),
    reason: canonicalString(2_000),
    source: ticketProposalSource.optional(),
    authorAssessment: ticketProposalAuthorAssessment,
    changes: z.array(ticketProposalGraphChange)
      .min(1)
      .max(TICKET_PROPOSAL_MAX_CHANGES),
  }).strict(),
]).refine(isTicketProposalInputWithinBudgetV0, {
  message: `Ticket proposal input must not exceed ${TICKET_PROPOSAL_MAX_INPUT_BYTES} JSON bytes`,
});
const ticketProposalList = z.object({
  kind: z.enum(["comment", "graph_change"]).optional(),
  observedSnapshotId: ticketSnapshotId.nullable().optional(),
  cursor: canonicalString(2_000).optional(),
  limit: z.number().int().min(1).max(TICKET_PROPOSAL_MAX_PAGE_SIZE).optional(),
}).strict();
const ticketProposalValidationSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("proposal") }).strict(),
  z.object({
    kind: z.literal("ticket_change"),
    ticketId,
    definitionRevision: ticketDefinitionRevision,
  }).strict(),
  z.object({
    kind: z.literal("dependency_change"),
    change: z.enum(["added", "removed"]),
    prerequisiteTicketId: ticketId,
    dependentTicketId: ticketId,
  }).strict(),
]);
const ticketProposalValidationDescriptor = z.object({
  id,
  version: canonicalString(100),
  artifactDigest: sha256Digest,
}).strict();
const ticketProposalValidationEvidenceRefs = z.array(canonicalString(2_000))
  .min(1)
  .max(50)
  .refine((refs) => new Set(refs).size === refs.length, {
    message: "evidence refs must be unique",
  });
const ticketProposalValidationCheck = z.object({
  localRef: id,
  code: z.enum(TICKET_PROPOSAL_VALIDATION_CHECK_CODES),
  subject: ticketProposalValidationSubject,
  outcome: z.enum(["passed", "failed", "inconclusive"]),
  summary: canonicalString(500),
  evidenceRefs: ticketProposalValidationEvidenceRefs,
}).strict();
const ticketProposalValidationFinding = z.object({
  localRef: id,
  checkLocalRef: id,
  subject: ticketProposalValidationSubject,
  impact: z.enum(["blocking", "advisory"]),
  code: canonicalString(100),
  summary: canonicalString(500),
  detail: boundedString(20_000).optional(),
  evidenceRefs: ticketProposalValidationEvidenceRefs,
  suggestedAction: canonicalString(2_000).optional(),
}).strict();
const ticketProposalValidationRecord = z.object({
  schemaVersion: z.literal(TICKET_PROPOSAL_VALIDATION_SCHEMA_VERSION),
  proposalId: ticketProposalId,
  expectedProposalDigest: sha256Digest,
  expectedCandidateDigest: sha256Digest,
  validator: ticketProposalValidationDescriptor,
  policy: ticketProposalValidationDescriptor,
  checks: z.array(ticketProposalValidationCheck)
    .length(TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length),
  findings: z.array(ticketProposalValidationFinding).max(200),
  indicatedAuthoritySignals: z.array(z.enum(TICKET_PROPOSAL_AUTHORITY_SIGNALS))
    .max(TICKET_PROPOSAL_AUTHORITY_SIGNALS.length)
    .refine((signals) => new Set(signals).size === signals.length, {
      message: "authority signals must be unique",
    }),
}).strict().superRefine((input, context) => {
  if (new Set(input.checks.map((check) => check.localRef)).size
    !== input.checks.length) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "check localRef values must be unique",
    });
  }
  const codes = new Set(input.checks.map((check) => check.code));
  if (codes.size !== TICKET_PROPOSAL_VALIDATION_CHECK_CODES.length
    || TICKET_PROPOSAL_VALIDATION_CHECK_CODES.some(
      (code) => !codes.has(code),
    )) {
    context.addIssue({
      code: "custom",
      path: ["checks"],
      message: "checks must contain every frozen proposal validation code once",
    });
  }
  if (new Set(input.findings.map((finding) => finding.localRef)).size
    !== input.findings.length) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "finding localRef values must be unique",
    });
  }
  const checks = new Map(input.checks.map((check) => [
    check.localRef,
    check,
  ]));
  const blockingByCheck = new Map<string, number>();
  input.findings.forEach((finding, index) => {
    const check = checks.get(finding.checkLocalRef);
    if (check === undefined) {
      context.addIssue({
        code: "custom",
        path: ["findings", index, "checkLocalRef"],
        message: "must reference a validation check in the same receipt",
      });
      return;
    }
    if (finding.impact === "blocking") {
      blockingByCheck.set(
        finding.checkLocalRef,
        (blockingByCheck.get(finding.checkLocalRef) ?? 0) + 1,
      );
      if (check.outcome === "passed") {
        context.addIssue({
          code: "custom",
          path: ["findings", index, "impact"],
          message: "a passed check cannot carry a blocking finding",
        });
      }
    }
  });
  input.checks.forEach((check, index) => {
    if (check.outcome !== "passed"
      && (blockingByCheck.get(check.localRef) ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ["checks", index, "outcome"],
        message: "failed or inconclusive checks require a blocking finding",
      });
    }
  });
}).refine(
  (input) => isJsonValueWithinByteBudgetV0(
    input,
    TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  ),
  {
    message: `Ticket proposal validation input must not exceed ${TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES} JSON bytes`,
  },
);
const ticketProposalValidationList = z.object({
  proposalId: ticketProposalId,
  cursor: canonicalString(2_000).optional(),
  limit: z.number().int().min(1)
    .max(TICKET_PROPOSAL_VALIDATION_MAX_PAGE_SIZE)
    .optional(),
}).strict();

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
const specSchema=z.object({id,featureId:id.optional(),type:specType,summary:short,detail:long.optional(),priority:id.optional(),layer:id.optional(),domain:id.optional(),tags:tags.optional(),evidence:z.array(evidenceSchema).min(1).max(50),anchors:z.array(anchorSchema).max(100).optional(),relations:z.array(relationSchema).max(100).optional()}).strict();
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
  "kb.spec.apply": z.object({idempotencyKey:key,specs:z.array(specSchema).min(1).max(100)}).strict(),
  "kb.mark-stale": z.object(mutationBase).strict(),
  "kb.deprecate": z.object(mutationBase).strict(),
  "kb.amend": z.object({...mutationBase,type:specType.optional(),summary:short.optional(),detail:long.nullable().optional(),priority:id.nullable().optional(),layer:id.nullable().optional(),domain:id.nullable().optional(),tags:tags.optional(),featureId:id.nullable().optional(),evidence:z.array(evidenceSchema).min(1).max(50),anchors:z.array(anchorSchema).max(100).optional()}).strict(),
  "kb.supersede": z.object({...mutationBase,replacementSpecId:id,rationale:long.optional()}).strict(),
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
  "ticket.graph.snapshot": z.object({
    cursor: canonicalString(2_000).optional(),
    pageSize: z.number().int().min(1).max(TICKET_REVIEW_MAX_PAGE_SIZE).optional(),
  }).strict(),
  "ticket.subject.inspect": z.object({
    snapshotId: ticketOpaqueRef,
    subject: ticketReviewSubject,
  }).strict(),
  "ticket.trace.list": z.object({
    snapshotId: ticketOpaqueRef,
    subject: ticketReviewSubject,
    kinds: ticketTraceKinds.optional(),
    cursor: canonicalString(2_000).optional(),
    limit: z.number().int().min(1)
      .max(TICKET_REVIEW_MAX_TRACE_RECORDS_PER_PAGE)
      .optional(),
  }).strict(),
  "ticket.proposal.submit": ticketProposalSubmit,
  "ticket.proposal.inspect": z.object({ proposalId: ticketProposalId }).strict(),
  "ticket.proposal.list": ticketProposalList,
  "ticket.proposal.validation.record": ticketProposalValidationRecord,
  "ticket.proposal.validation.inspect": z.object({
    validationReceiptId: ticketProposalValidationReceiptId,
  }).strict(),
  "ticket.proposal.validation.list": ticketProposalValidationList,
} as const;

export const OPERATION_INPUT_BYTE_LIMITS = {
  "ticket.proposal.submit": TICKET_PROPOSAL_MAX_INPUT_BYTES,
  "ticket.proposal.inspect": 16 * 1024,
  "ticket.proposal.list": 32 * 1024,
  "ticket.proposal.validation.record":
    TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
  "ticket.proposal.validation.inspect": 16 * 1024,
  "ticket.proposal.validation.list": 32 * 1024,
} as const satisfies Partial<Record<keyof typeof operationInputSchemas, number>>;

/** Unknown operation inputs are bounded before hashing for receipt replay. */
export const UNKNOWN_OPERATION_INPUT_MAX_BYTES = 64 * 1024;

export function isOperationInputWithinBudget(
  operation: string,
  input: unknown,
): boolean {
  const maximum = OPERATION_INPUT_BYTE_LIMITS[
    operation as keyof typeof OPERATION_INPUT_BYTE_LIMITS
  ];
  if (maximum !== undefined) {
    return isJsonValueWithinByteBudgetV0(input, maximum);
  }
  return Object.prototype.hasOwnProperty.call(operationInputSchemas, operation)
    || isJsonValueWithinByteBudgetV0(
      input,
      UNKNOWN_OPERATION_INPUT_MAX_BYTES,
    );
}

/**
 * Audited cross-field rules that Zod's JSON Schema conversion cannot preserve
 * by itself. `runtimeSites` must equal the number of `.refine` calls owning the
 * rule in this file; the contract generator checks the aggregate against the
 * source before publishing the artifact.
 */
export const operationRefinementManifest = {
  "evidence-content": {runtimeSites:1,operations:["kb.spec.apply","kb.amend"]},
  "anchor-line-range": {runtimeSites:1,operations:["kb.ingest.preview","kb.spec.apply","kb.amend","distill.candidates.put"]},
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
  "ticket-trace-kinds-unique": {runtimeSites:1,operations:["ticket.trace.list"]},
  "ticket-proposal-input-byte-budget": {runtimeSites:1,operations:["ticket.proposal.submit"]},
  "ticket-proposal-authority-signals-unique": {runtimeSites:1,operations:["ticket.proposal.submit"]},
  "ticket-proposal-validation-input-byte-budget": {runtimeSites:1,operations:["ticket.proposal.validation.record"]},
  "ticket-proposal-validation-authority-signals-unique": {runtimeSites:1,operations:["ticket.proposal.validation.record"]},
  "ticket-proposal-validation-evidence-refs-unique": {runtimeSites:1,operations:["ticket.proposal.validation.record"]},
  "ticket-proposal-validation-coherence": {runtimeSites:1,operations:["ticket.proposal.validation.record"]},
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
  regex: 7,
  isoDatetime: 1,
  union: 1,
  discriminatedUnion: 7,
  unknown: 1,
  strict: 82,
  safeExtend: 1,
  optional: 104,
  nullable: 12,
  check: 1,
  custom: 1,
  meta: 1,
  overwrite: 0,
  normalize: 0,
  lowercase: 0,
  uppercase: 0,
  nonempty: 0,
  length: 1,
  any: 0,
} as const;

export type OperationName=keyof typeof operationInputSchemas;
