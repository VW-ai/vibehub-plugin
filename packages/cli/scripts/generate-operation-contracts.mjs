import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import {
  OPERATION_INPUT_BYTE_LIMITS,
  operationAcceptanceConstructManifest,
  operationInputSchemas,
  operationRefinementManifest,
} from "@vw-ai/vibehub-core";
import {
  materializeOperationFixture,
  validateOperationContract,
  validateRuntimeRefinements,
} from "../../../skills/scripts/operation-contract-validator.mjs";

const EXPECTED_INPUT_SCHEMA_HASH="1d77dda56a6135f5413a6e3a2cbd7ccfc9113eb535a12c4ed29f4a864bbdbf30";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const ajv=new Ajv2020({allErrors:true,strict:false});
const operations={};
const refinementMatrix=buildRefinementMatrix();
assertRefinementAudit(refinementMatrix);
assertAcceptanceConstructAudit();

for(const [name,schema] of Object.entries(operationInputSchemas).sort(([a],[b])=>a.localeCompare(b))){
  const input=addRepresentableRefinements(name,structuredClone(schema.toJSONSchema()));
  assertSerializedStringAcceptance(name,input);
  const positive=positiveFixture(name);
  const negatives=negativeFixtures(name,positive,input);
  if(!negatives.length)throw new Error(`missing negative fixtures: ${name}`);
  for(const fixture of negatives)if(!fixture.value||typeof fixture.value!=="object"||Array.isArray(fixture.value)||!fixture.case||!Array.isArray(fixture.refinementIds))throw new Error(`trivial negative fixture: ${name}`);
  const runtimeRefinements=runtimeRefinementsFor(name);
  const validate=ajv.compile(input);
  for(const candidate of differentialStringCorpus(positive)){
    const schemaValid=validate(candidate.value),runtimeErrors=[];validateRuntimeRefinements(runtimeRefinements,candidate.value,runtimeErrors);
    const artifactValid=Boolean(schemaValid)&&runtimeErrors.length===0,zodValid=schema.safeParse(candidate.value).success;
    const packagedValid=validateOperationContract({input,runtimeRefinements},candidate.value).valid;
    if(artifactValid!==zodValid||packagedValid!==zodValid)throw new Error(`differential string parity drift: ${name}/${candidate.case}: artifact=${artifactValid} packaged=${packagedValid} runtime=${zodValid}`);
  }
  const artifactPositive=validate(positive),artifactPositiveErrors=validate.errors;
  const positiveRuntimeErrors=[];validateRuntimeRefinements(runtimeRefinements,positive,positiveRuntimeErrors);
  const runtimePositive=schema.safeParse(positive).success;
  if(!artifactPositive||positiveRuntimeErrors.length||!runtimePositive)throw new Error(`positive parity drift: ${name}: schema=${artifactPositive} refinements=${JSON.stringify(positiveRuntimeErrors)} runtime=${runtimePositive} ${JSON.stringify(artifactPositiveErrors)}`);
  for(const fixture of negatives){
    const schemaValid=validate(fixture.value),schemaErrors=validate.errors,runtimeErrors=[];validateRuntimeRefinements(runtimeRefinements,fixture.value,runtimeErrors);
    const artifactValid=Boolean(schemaValid)&&runtimeErrors.length===0,runtimeValid=schema.safeParse(fixture.value).success;
    if(artifactValid||runtimeValid)throw new Error(`negative parity drift: ${name}/${fixture.case}: artifact=${artifactValid} runtime=${runtimeValid} schema=${JSON.stringify(schemaErrors)} refinements=${JSON.stringify(runtimeErrors)}`);
  }
  for(const [id,entry] of Object.entries(refinementMatrix))if(entry.operations.includes(name)&&!negatives.some(fixture=>fixture.refinementIds.includes(id)))throw new Error(`missing refinement fixture coverage: ${name}/${id}`);
  const publishedNegatives=negatives.map(publishFixture);
  const contract={input,runtimeRefinements,fixtures:{positive,negative:negatives[0].value,negativeCase:negatives[0].case,negatives:publishedNegatives}};
  for(const fixture of publishedNegatives.filter(candidate=>candidate.materializer)){
    const materialized=materializeOperationFixture(contract,fixture);
    const schemaValid=validate(materialized),runtimeErrors=[];validateRuntimeRefinements(runtimeRefinements,materialized,runtimeErrors);
    const expectedRuntimeFailure=fixture.refinementIds.every(id=>runtimeErrors.some(error=>error.refinementId===id));
    if(!schemaValid||!expectedRuntimeFailure||schema.safeParse(materialized).success||validateOperationContract(contract,materialized).valid)throw new Error(`generated negative fixture parity drift: ${name}/${fixture.case}`);
  }
  operations[name]=contract;
}

const inputSchemaHash=crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(operations).map(([name,contract])=>[name,contract.input])))).digest("hex");
if(inputSchemaHash!==EXPECTED_INPUT_SCHEMA_HASH)throw new Error(`operation input acceptance fingerprint changed: expected ${EXPECTED_INPUT_SCHEMA_HASH}, got ${inputSchemaHash}; review the full serialized diff before updating the explicit fingerprint`);
const registryHash=crypto.createHash("sha256").update(JSON.stringify(operations)).digest("hex");
const artifact={
  schemaVersion:5,registryHash,inputSchemaHash,
  dialect:"JSON Schema 2020-12 plus VibeHub runtimeRefinements/v1",
  fixtureDialect:"literal value or generatedFixture/v1",
  scope:"Operation input contracts only. Operation context is validated separately by the runtime operationContextSchema at CLI/MCP adapter boundaries.",
  validationContract:"An input is valid only when both `input` JSON Schema and `runtimeRefinements` pass.",
  acceptanceConstructs:operationAcceptanceConstructManifest,
  refinementMatrix,
  envelope:{
    success:{type:"object",additionalProperties:false,required:["ok","data","meta"],properties:{
      ok:{const:true},data:{},meta:{type:"object",additionalProperties:false,required:["operation","repoId","requestId","at"],properties:{operation:{type:"string"},repoId:{type:"integer",minimum:1},requestId:{type:"string",minLength:1},at:{type:"string"}}},
    }},
    error:{type:"object",additionalProperties:false,required:["ok","error"],properties:{
      ok:{const:false},error:{type:"object",additionalProperties:false,required:["code","message","details","nextSafeActions"],properties:{code:{type:"string"},message:{type:"string"},details:{},nextSafeActions:{type:"array",items:{type:"string"}}}},
    }},
  },operations,
};
const target=path.join(root,"skills/contracts/operation-contracts.json");
fs.writeFileSync(target,`${JSON.stringify(artifact,null,2)}\n`);
const limitsTarget=path.join(root,"skills/scripts/generated-operation-limits.mjs");
fs.writeFileSync(
  limitsTarget,
  [
    "/** Generated by packages/cli/scripts/generate-operation-contracts.mjs. */",
    `export const OPERATION_INPUT_BYTE_LIMITS = Object.freeze(${JSON.stringify(OPERATION_INPUT_BYTE_LIMITS, null, 2)});`,
    "",
  ].join("\n"),
);
console.log(`generated ${Object.keys(operations).length} operation contracts with audited refinements (${registryHash.slice(0,12)})`);

/** Add only refinements that JSON Schema 2020-12 can express exactly. */
function addRepresentableRefinements(name,schema){
  walk(schema,node=>{
    const p=node?.properties;
    if(!p)return;
    if(p.sourceRef&&p.exactQuote&&p.evidenceRef&&p.contentHash){
      node.anyOf=[{required:["exactQuote"]},{required:["evidenceRef"]},{required:["contentHash"]}];
    }
    if(p.lineStart&&p.lineEnd){
      node.dependentRequired={...(node.dependentRequired??{}),lineEnd:["lineStart"]};
    }
    if(p.classification&&p.reason&&p.contentHash){
      node.allOf=[...(node.allOf??[]),
        {if:{properties:{classification:{const:"included"}},required:["classification"]},then:{required:["contentHash"],not:{required:["reason"]}}},
        {if:{properties:{classification:{const:"excluded"}},required:["classification"]},then:{required:["reason"]}},
        {if:{properties:{changeKind:{enum:["added","modified","renamed","unchanged"]}},required:["changeKind"]},then:{required:["contentHash"]}},
        {if:{properties:{changeKind:{const:"deleted"}},required:["changeKind"]},then:{properties:{classification:{const:"excluded"},reason:{const:"incremental_deleted"}},required:["classification","reason"]},else:{not:{properties:{reason:{const:"incremental_deleted"}},required:["reason"]}}},
        {if:{properties:{changeKind:{const:"unchanged"}},required:["changeKind"]},then:{properties:{classification:{const:"excluded"},reason:{enum:["incremental_unchanged","non_regular_file"]}},required:["classification","reason"]},else:{not:{properties:{reason:{const:"incremental_unchanged"}},required:["reason"]}}},
      ];
    }
  });
  if(name==="distill.candidates.get"||name==="distill.candidates.list"){
    schema.oneOf=[
      {required:["runId"],not:{required:["versionId"]}},
      {required:["versionId"],not:{required:["runId"]}},
    ];
  }
  if(name==="ticket.trace.list"&&schema.properties?.kinds){
    schema.properties.kinds.uniqueItems=true;
  }
  return schema;
}

function runtimeRefinementsFor(name){
  const rules=[];
  if(["kb.ingest.preview","kb.spec.apply","kb.amend","distill.candidates.put"].includes(name))rules.push({id:"anchor-line-range",kind:"fieldCompare",matchFields:["lineStart","lineEnd"],leftField:"lineEnd",operator:"gte",rightField:"lineStart",message:"lineEnd must not precede lineStart"});
  if(name==="distill.candidates.put")rules.push({id:"relation-distinct-endpoints",kind:"fieldCompare",matchFields:["fromKind","fromId","toKind","toId"],leftField:"fromId",operator:"notEqual",rightField:"toId",message:"relation endpoints must differ"});
  if(name==="ticket.worktree.patch")rules.push({id:"ticket-patch-id-match",kind:"nestedFieldCompare",matchFields:["ticketId","document"],leftField:"ticketId",operator:"equal",rightObjectField:"document",rightField:"ticket_id",message:"patch Ticket ID must match document.ticket_id"});
  if(name==="distill.scopes.complete"){
    rules.push({id:"scope-completion-byte-budget",kind:"maxJsonBytes",maximum:1_048_576,message:"scope completion payload must not exceed 1 MiB"});
    rules.push({id:"scope-completion-evidence-budget",kind:"maxNestedArrayItems",parentField:"unresolvedFiles",childField:"evidence",maximum:200,message:"scope completion may contain at most 200 evidence entries"});
  }
  return rules;
}

function walk(value,visit){
  if(!value||typeof value!=="object")return;
  visit(value);
  for(const child of Object.values(value))if(child&&typeof child==="object")walk(child,visit);
}

function positiveFixture(name){
  const runId="fixture-run",specId="context-fixture",key="fixture-key",lease={runId,scopeId:"scope",leaseToken:"lease",generation:1};
  const ticketRun={
    runId:`trn-${"6".repeat(64)}`,
    generation:1,
    leaseToken:"vht_fixture-bearer",
  };
  const ticketSource={
    sourceToken:`tls-${"1".repeat(64)}`,
    worktreeIdentity:`worktree-${"2".repeat(64)}`,
    resolvedCommit:"3".repeat(40),
    graphDigest:`sha256:${"4".repeat(64)}`,
    semanticLedgerDigest:`sha256:${"5".repeat(64)}`,
  };
  const fixtures={
    "kb.status":{},"kb.feature.list":{query:"two words"},"kb.feature.get":{id:"x".repeat(200)},"kb.feature.suggest":{},
    "kb.spec.search":{paths:["src/two words.ts"],tags:["two words"]},"kb.spec.get":{id:specId},"kb.relations":{specId},"kb.lineage":{id:specId},"kb.anchors":{specId},"kb.review":{},
    "kb.ingest.preview":{specs:[{summary:"Fixture fact"}]},
    "kb.spec.apply":{idempotencyKey:key,specs:[{id:specId,type:"context",summary:"Fixture fact",evidence:[{sourceType:"fixture",sourceRef:"fixture:1",exactQuote:"quoted evidence",evidenceRef:"fixture:1"}]}]},
    "kb.mark-stale":{specId,idempotencyKey:key},"kb.deprecate":{specId,idempotencyKey:key},
    "kb.amend":{specId,idempotencyKey:key,evidence:[{sourceType:"fixture",sourceRef:"fixture:1",evidenceRef:"fixture:1"}]},
    "kb.supersede":{specId,idempotencyKey:key,replacementSpecId:"context-replacement"},
    "distill.run.start":{runId,mode:"cold",baseCommit:"0123456789abcdef0123456789abcdef01234567",skillHash:"skill",configHash:"config"},
    "distill.run.status":{runId},"distill.run.resume":{runId},"distill.run.abort":{runId,reason:"fixture"},
    "distill.inventory.put":{runId,rows:[{path:"src/a.ts",classification:"included",contentHash:"hash"}]},"distill.inventory.get":{runId},"distill.inventory.diff":{runId,paths:["src/a.ts"]},"distill.inventory.seal":{runId},
    "distill.scopes.plan":{runId,scopes:[{scopeId:"scope",parentScopeId:null,kind:"leaf",files:["src/a.ts"]}]},"distill.scopes.claim":{runId,workerId:"worker",leaseSeconds:60},
    "distill.scopes.complete":{...lease,coveredFiles:[],unresolvedFiles:[{path:"src/a.ts",reason:"No honest feature placement",evidence:[{sourceRef:"src/a.ts",contentHash:"hash"}]}]},"distill.scopes.fail":{...lease,reason:"fixture"},"distill.scopes.retry":{runId,scopeId:"scope",reason:"fixture"},"distill.scopes.correct":{runId,scopeIds:["scope"],reason:"fixture"},
    "distill.candidates.put":{runId,kind:"feature",naturalId:"feature",sourceScopeId:"scope",leaseToken:"lease",generation:1,payload:{name:"Feature"},evidence:[{sourceRef:"src/a.ts",contentHash:"hash"}]},
    "distill.candidates.get":{runId,kind:"feature",naturalId:"feature"},"distill.candidates.list":{runId},"distill.baseline.get":{selector:"active"},
    "distill.version.get":{versionId:"version"},"distill.version.diff":{versionId:"version"},
    "distill.reconcile":{runId},"distill.validate":{runId},"distill.finalize":{runId},
    "distill.activate":{targetVersionId:"version",expectedCurrentVersion:null,reason:"fixture"},"distill.rollback":{targetVersionId:"version",expectedCurrentVersion:null,reason:"fixture"},
    "ticket.graph.snapshot":{},
    "ticket.subject.inspect":{snapshotId:"tgs-fixture",subject:{kind:"ticket",ticketId:"TKT-1"}},
    "ticket.trace.list":{snapshotId:"tgs-fixture",subject:{kind:"ticket",ticketId:"TKT-1"},kinds:["evidence"],limit:10},
    "ticket.worktree.patch":{
      expectedSource:ticketSource,
      changes:[{
        op:"put",
        ticketId:"fixture-ticket",
        expectedTicketRevision:null,
        document:{
          schema_version:1,
          kind:"ticket",
          ticket_id:"fixture-ticket",
          outcome:"Create the fixture Ticket",
          context:"Exercise the exact-base patch contract.",
          acceptance:[],
          constraints:[],
          context_refs:[],
          relations:[],
          provenance_refs:[],
        },
      }],
    },
    "ticket.review.append":{
      expectedSource:ticketSource,
      review:{
        type:"comment",
        subject:{
          kind:"graph",
          graphDigest:ticketSource.graphDigest,
        },
        body:"The exact graph is ready for focused review.",
      },
    },
    "ticket.decision.record":{
      expectedSource:ticketSource,
      decision:{
        type:"plan_review",
        subject:{
          kind:"graph",
          graphDigest:ticketSource.graphDigest,
        },
        disposition:"approve_execution",
        rationale:"The reviewed graph has a bounded execution path.",
        resolutionRefs:[],
      },
    },
    "ticket.frontier.read":{},
    "ticket.context.compile":{
      expectedSource:ticketSource,
      ticketId:"fixture-ticket",
      expectedTicketRevision:`sha256:${"7".repeat(64)}`,
    },
    "ticket.run.claim":{
      expectedSource:ticketSource,
      ticketId:"fixture-ticket",
      expectedTicketRevision:`sha256:${"7".repeat(64)}`,
      contextBindingId:`tcb-${"8".repeat(64)}`,
      contextBindingDigest:`sha256:${"9".repeat(64)}`,
      leaseSeconds:300,
    },
    "ticket.run.heartbeat":{...ticketRun,leaseSeconds:300},
    "ticket.run.release":{...ticketRun,reason:"lease_released"},
    "ticket.evidence.append":{
      expectedSource:ticketSource,
      run:ticketRun,
      acceptanceId:"observable-result",
      evidenceType:"test",
      summary:"The focused conformance test passed.",
      references:[{
        kind:"repo_path",
        label:"Conformance report",
        target:"artifacts/conformance.json",
        digest:`sha256:${"a".repeat(64)}`,
      }],
    },
    "ticket.closeout.append":{
      expectedSource:ticketSource,
      runId:ticketRun.runId,
      generation:ticketRun.generation,
      terminalForm:"successful",
      executorReport:"Implemented the bounded Ticket outcome.",
      acceptance:[{
        acceptanceId:"observable-result",
        disposition:"accepted",
        evidenceRefs:[`tev-${"b".repeat(64)}`],
        rationale:"The independent verifier accepted the exact evidence.",
      }],
      followUpTicketRefs:[],
      semanticCloseoutRefs:[],
    },
  };
  if(!(name in fixtures))throw new Error(`missing positive operation fixture: ${name}`);
  return fixtures[name];
}

function negativeFixtures(name,positive,input){
  const explicit={
    "kb.feature.list":[fixture("limit below minimum",{limit:0})],
    "kb.feature.get":[
      fixture("top-level id rejects whitespace only",{id:" \t"}),
      fixture("top-level id rejects leading whitespace",{id:" feature"}),
      fixture("top-level id rejects trailing whitespace",{id:"feature\n"}),
      fixture("top-level id measures raw padded length",{id:`${"x".repeat(200)} `}),
      fixture("top-level id measures Unicode characters consistently",{id:"😀".repeat(201)}),
    ],
    "kb.feature.suggest":[fixture("limit above maximum",{limit:51})],
    "kb.spec.search":[
      fixture("limit above maximum",{limit:201}),
      fixture("array tag rejects whitespace only",{tags:[" "]}),
      fixture("array path rejects leading whitespace",{paths:[" src/a.ts"]}),
      fixture("array path rejects dot-prefix normalization",{paths:["./src/a.ts"]}),
      fixture("array path rejects parent-segment normalization",{paths:["src/../a.ts"]}),
      fixture("array path rejects backslash normalization",{paths:["src\\a.ts"]}),
    ],
    "kb.relations":[fixture("depth above maximum",{specId:"x",depth:6})],
    "kb.lineage":[fixture("depth above maximum",{id:"x",maxDepth:101})],
    "kb.anchors":[fixture("union branches are mutually strict",{specId:"x",path:"src/a.ts"},["anchors-strict-union"]),fixture("union requires one selector",{},["anchors-strict-union"])],
    "kb.review":[fixture("limit above maximum",{limit:501})],
    "kb.ingest.preview":[
      fixture("lineEnd requires lineStart",{specs:[{summary:"x",anchors:[{file:"src/a.ts",lineEnd:2}]}]},["anchor-line-range"]),
      fixture("lineEnd must not precede lineStart",{specs:[{summary:"x",anchors:[{file:"src/a.ts",lineStart:3,lineEnd:2}]}]},["anchor-line-range"]),
    ],
    "kb.spec.apply":[
      fixture("evidence requires content",{...positive,specs:[{...positive.specs?.[0],evidence:[{sourceType:"fixture",sourceRef:"fixture:1"}]}]},["evidence-content"]),
      fixture("spec anchor lineEnd requires lineStart",{...positive,specs:[{...positive.specs?.[0],anchors:[{file:"src/a.ts",lineEnd:2}]}]},["anchor-line-range"]),
      fixture("spec anchor lineEnd order",{...positive,specs:[{...positive.specs?.[0],anchors:[{file:"src/a.ts",lineStart:3,lineEnd:2}]}]},["anchor-line-range"]),
      fixture("nested summary rejects leading whitespace",{...positive,specs:[{...positive.specs?.[0],summary:" Fixture fact"}]}),
      fixture("nested evidence sourceRef rejects whitespace only",{...positive,specs:[{...positive.specs?.[0],evidence:[{sourceType:"fixture",sourceRef:" ",evidenceRef:"fixture:1"}]}]}),
      fixture("nested anchor contentHash rejects trailing whitespace",{...positive,specs:[{...positive.specs?.[0],anchors:[{file:"src/a.ts",contentHash:"hash "}]}]}),
      fixture("nested long string measures Unicode characters consistently",{...positive,specs:[{...positive.specs?.[0],evidence:[{sourceType:"fixture",sourceRef:"fixture:1",exactQuote:"😀".repeat(20_001)}]}]}),
    ],
    "kb.amend":[
      fixture("evidence requires content",{...positive,evidence:[{sourceType:"fixture",sourceRef:"fixture:1"}]},["evidence-content"]),
      fixture("amend anchor lineEnd requires lineStart",{...positive,anchors:[{file:"src/a.ts",lineEnd:2}]},["anchor-line-range"]),
      fixture("amend anchor lineEnd order",{...positive,anchors:[{file:"src/a.ts",lineStart:3,lineEnd:2}]},["anchor-line-range"]),
    ],
    "distill.run.start":[fixture("commit must be forty lowercase hex characters",{...positive,baseCommit:"not-a-commit"})],
    "distill.inventory.put":[
      fixture("included inventory row requires contentHash",{...positive,rows:[{path:"src/a.ts",classification:"included"}]},["inventory-classification"]),
      fixture("excluded inventory row requires reason",{...positive,rows:[{path:"src/a.ts",classification:"excluded"}]},["inventory-classification"]),
      fixture("included inventory row rejects exclusion reason",{...positive,rows:[{path:"src/a.ts",classification:"included",contentHash:"hash",reason:"binary_file"}]},["inventory-included-no-reason"]),
      fixture("modified inventory row requires target contentHash",{...positive,rows:[{path:"src/a.ts",classification:"excluded",reason:"generated_or_dependency",changeKind:"modified"}]},["inventory-change-hash"]),
      fixture("deleted inventory row requires exact reason",{...positive,rows:[{path:"src/a.ts",classification:"excluded",reason:"binary_file",changeKind:"deleted"}]},["inventory-deleted-reason"]),
      fixture("unchanged inventory row requires exact reason",{...positive,rows:[{path:"src/a.ts",classification:"excluded",reason:"binary_file",contentHash:"hash",changeKind:"unchanged"}]},["inventory-unchanged-reason"]),
    ],
    "distill.inventory.diff":[fixture("paths above maximum",{...positive,paths:Array.from({length:10001},(_,i)=>`src/${i}.ts`)})],
    "distill.scopes.claim":[fixture("lease below minimum",{...positive,leaseSeconds:0})],
    "distill.scopes.plan":[fixture("nested file array rejects trailing whitespace",{...positive,scopes:[{...positive.scopes?.[0],files:["src/a.ts "]}]})],
    "distill.scopes.complete":[
      fixture("unresolved disposition cannot claim feature placement",{...positive,unresolvedFiles:[{path:"src/a.ts",reason:"Unknown",featureId:"fake"}]}),
      fixture("scope completion aggregate byte budget",{...positive,unresolvedFiles:Array.from({length:3},(_,i)=>({path:`src/${i}.ts`,reason:"Unknown",evidence:Array.from({length:20},(_,j)=>({sourceRef:`src/${i}-${j}.ts`,exactQuote:"x".repeat(20_000)}))}))},["scope-completion-byte-budget"]),
      fixture("scope completion aggregate evidence budget",{...positive,unresolvedFiles:Array.from({length:11},(_,i)=>({path:`src/${i}.ts`,reason:"Unknown",evidence:Array.from({length:20},(_,j)=>({sourceRef:`src/${i}-${j}.ts`,contentHash:"hash"}))}))},["scope-completion-evidence-budget"]),
    ],
    "distill.candidates.put":[
      fixture("candidate evidence requires content",{...positive,evidence:[{sourceRef:"src/a.ts"}]},["candidate-evidence-content"]),
      fixture("anchor candidate lineEnd requires lineStart",{...positive,kind:"anchor",payload:{featureId:"feature",file:"src/a.ts",contentHash:"hash",lineEnd:2}},["anchor-line-range","candidate-discriminated-union"]),
      fixture("anchor candidate lineEnd order",{...positive,kind:"anchor",payload:{featureId:"feature",file:"src/a.ts",contentHash:"hash",lineStart:3,lineEnd:2}},["anchor-line-range","candidate-discriminated-union"]),
      fixture("relation candidate endpoints must differ",{...positive,kind:"relation",payload:{fromKind:"spec",fromId:"same",toKind:"spec",toId:"same",type:"depends_on"}},["relation-distinct-endpoints","candidate-discriminated-union"]),
      fixture("candidate discriminant must match payload",{...positive,kind:"anchor",payload:{name:"Feature"}},["candidate-discriminated-union"]),
    ],
    "distill.candidates.get":[fixture("both run and version selectors",{...positive,versionId:"version"},["candidate-selector-exactly-one"]),fixture("missing run and version selector",{kind:"feature",naturalId:"feature"},["candidate-selector-exactly-one"])],
    "distill.candidates.list":[fixture("both run and version selectors",{...positive,versionId:"version"},["candidate-selector-exactly-one"]),fixture("missing run and version selector",{},["candidate-selector-exactly-one"])],
    "distill.version.diff":[fixture("kind filter above maximum",{...positive,kinds:["feature","spec","anchor","feature"]})],
    "ticket.graph.snapshot":[
      fixture("page size below minimum",{pageSize:0}),
      fixture("cursor rejects whitespace only",{cursor:" "}),
    ],
    "ticket.subject.inspect":[
      fixture("snapshot id rejects leading whitespace",{...positive,snapshotId:" tgs-fixture"}),
      fixture("subject discriminant branch rejects extra relation selector",{...positive,subject:{kind:"ticket",ticketId:"TKT-1",relationRef:"relation-1"}}),
    ],
    "ticket.trace.list":[
      fixture("trace kinds must be unique",{...positive,kinds:["evidence","evidence"]},["ticket-trace-kinds-unique"]),
      fixture("trace limit above maximum",{...positive,limit:201}),
      fixture("trace subject rejects trailing whitespace",{...positive,subject:{kind:"ticket",ticketId:"TKT-1 "}}),
    ],
    "ticket.context.compile":[
      fixture("context Ticket revision must be exact",{...positive,expectedTicketRevision:"latest"}),
      fixture("context Ticket ID must be canonical",{...positive,ticketId:"Fixture Ticket"}),
    ],
    "ticket.run.claim":[
      fixture("claim lease below minimum",{...positive,leaseSeconds:14}),
      fixture("claim context binding digest must be exact",{...positive,contextBindingDigest:"latest"}),
    ],
    "ticket.run.heartbeat":[
      fixture("heartbeat lease above maximum",{...positive,leaseSeconds:3601}),
      fixture("heartbeat generation must be positive",{...positive,generation:0}),
    ],
    "ticket.run.release":[
      fixture("release reason is closed",{...positive,reason:"done"}),
      fixture("release bearer rejects whitespace only",{...positive,leaseToken:" "}),
    ],
    "ticket.evidence.append":[
      fixture("evidence requires at least one reference",{...positive,references:[]}),
      fixture("evidence type is closed",{...positive,evidenceType:"claim"}),
    ],
    "ticket.closeout.append":[
      fixture("closeout terminal form is closed",{...positive,terminalForm:"done"}),
      fixture("closeout acceptance disposition is closed",{
        ...positive,
        acceptance:[{...positive.acceptance?.[0],disposition:"passed"}],
      }),
    ],
    "ticket.worktree.patch":[
      fixture("patch requires at least one change",{...positive,changes:[]}),
      fixture("patch source token must be exact",{...positive,expectedSource:{...positive.expectedSource,sourceToken:"latest"}}),
      fixture("patch Ticket ID must be canonical",{...positive,changes:[{...positive.changes?.[0],ticketId:"Ticket 1"}]}),
      fixture("patch change discriminant is closed",{...positive,changes:[{...positive.changes?.[0],op:"merge"}]}),
      fixture("patch create revision must be null or sha256",{...positive,changes:[{...positive.changes?.[0],expectedTicketRevision:"none"}]}),
      fixture("patch put requires a complete Ticket document",{...positive,changes:[{...positive.changes?.[0],document:{}}]}),
      fixture("patch Ticket document is closed",{...positive,changes:[{...positive.changes?.[0],document:{...positive.changes?.[0].document,extra:true}}]}),
      fixture("patch Ticket key must match document ID",{...positive,changes:[{...positive.changes?.[0],document:{...positive.changes?.[0].document,ticket_id:"other-ticket"}}]},["ticket-patch-id-match"]),
    ],
    "ticket.review.append":[
      fixture("review source semantic digest must be exact",{...positive,expectedSource:{...positive.expectedSource,semanticLedgerDigest:"latest"}}),
      fixture("review type is closed",{...positive,review:{...positive.review,type:"approval"}}),
      fixture("review subject is exact",{...positive,review:{...positive.review,subject:{kind:"graph"}}}),
      fixture("review body rejects whitespace only",{...positive,review:{...positive.review,body:" "}}),
    ],
    "ticket.decision.record":[
      fixture("decision source semantic digest must be exact",{...positive,expectedSource:{...positive.expectedSource,semanticLedgerDigest:"latest"}}),
      fixture("decision type is closed",{...positive,decision:{...positive.decision,type:"comment"}}),
      fixture("plan approval rejects delegated boundaries",{...positive,decision:{...positive.decision,delegatedBoundaries:["Do not broaden scope."]}}),
      fixture("decision rationale rejects whitespace only",{...positive,decision:{...positive.decision,rationale:" "}}),
    ],
  };
  if(explicit[name])return explicit[name];
  const value=structuredClone(positive);
  const required=input.required??[];
  if(required.length){delete value[required[0]];return [fixture(`missing required ${required[0]}`,value)];}
  value._unexpected=true;
  return [fixture("strict object rejects extra property",value)];
}

function fixture(caseName,value,refinementIds=[]){return {case:caseName,value,refinementIds};}
function generatedFixture(caseName,positive,materializer,refinementIds=[]){
  const descriptor={case:caseName,materializer,refinementIds};
  return {...descriptor,value:materializeOperationFixture({fixtures:{positive}},descriptor)};
}
function publishFixture(fixture){
  if(!fixture.materializer)return fixture;
  const {value:_value,...published}=fixture;
  return published;
}

function differentialStringCorpus(value){
  const variants=["x"," "," x","x ","x\n",...([40,100,101,200,201,300,301,500,501,1000,1001,2000,2001,20_000,20_001].map(n=>"😀".repeat(n)))];
  const leaves=[];const collect=(node,path=[])=>{if(typeof node==="string"){leaves.push(path);return;}if(Array.isArray(node)){node.forEach((child,index)=>collect(child,[...path,index]));return;}if(node&&typeof node==="object")for(const [key,child] of Object.entries(node))collect(child,[...path,key]);};collect(value);
  return leaves.flatMap((leaf,index)=>variants.map((variant,variantIndex)=>{const candidate=structuredClone(value);let cursor=candidate;for(const key of leaf.slice(0,-1))cursor=cursor[key];cursor[leaf.at(-1)]=variant;return {case:`leaf-${index}-variant-${variantIndex}`,value:candidate};}));
}

function buildRefinementMatrix(){
  const representation={
    "evidence-content":{representation:"json-schema",mechanism:"anyOf required exactQuote/evidenceRef/contentHash"},
    "anchor-line-range":{representation:"hybrid",mechanism:"dependentRequired plus runtimeRefinements/v1 fieldCompare gte"},
    "inventory-classification":{representation:"json-schema",mechanism:"if classification then required contentHash/reason"},
    "inventory-included-no-reason":{representation:"json-schema",mechanism:"if included then reason must be absent"},
    "inventory-change-hash":{representation:"json-schema",mechanism:"if non-deleted changeKind then required contentHash"},
    "inventory-deleted-reason":{representation:"json-schema",mechanism:"if deleted then exact incremental_deleted exclusion"},
    "inventory-unchanged-reason":{representation:"json-schema",mechanism:"if unchanged then incremental_unchanged or mode-priority non_regular_file exclusion"},
    "scope-completion-byte-budget":{representation:"runtime-refinement",mechanism:"runtimeRefinements/v1 maxJsonBytes"},
    "scope-completion-evidence-budget":{representation:"runtime-refinement",mechanism:"runtimeRefinements/v1 maxNestedArrayItems"},
    "candidate-evidence-content":{representation:"json-schema",mechanism:"anyOf required exactQuote/evidenceRef/contentHash"},
    "relation-distinct-endpoints":{representation:"runtime-refinement",mechanism:"runtimeRefinements/v1 fieldCompare notEqual"},
    "ticket-patch-id-match":{representation:"runtime-refinement",mechanism:"runtimeRefinements/v1 nestedFieldCompare equal"},
    "candidate-selector-exactly-one":{representation:"json-schema",mechanism:"oneOf required runId/versionId with not"},
    "candidate-discriminated-union":{representation:"json-schema",mechanism:"oneOf strict kind-const branches"},
    "anchors-strict-union":{representation:"json-schema",mechanism:"anyOf strict single-property branches"},
    "ticket-trace-kinds-unique":{representation:"json-schema",mechanism:"uniqueItems on kinds"},
  };
  return Object.fromEntries(Object.entries(operationRefinementManifest).map(([id,entry])=>{
    if(!representation[id])throw new Error(`runtime refinement lacks artifact representation: ${id}`);
    return [id,{...entry,...representation[id]}];
  }));
}

function assertRefinementAudit(matrix){
  const source=fs.readFileSync(path.join(root,"packages/core/src/operation-contracts.ts"),"utf8");
  const actualSites=(source.match(/\.(?:superRefine|refine)\s*\(/g)??[]).length;
  const declaredSites=Object.values(operationRefinementManifest).reduce((sum,entry)=>sum+entry.runtimeSites,0);
  if(actualSites!==declaredSites)throw new Error(`refinement audit drift: source has ${actualSites} refine sites, manifest declares ${declaredSites}`);
  for(const [id,entry] of Object.entries(matrix))for(const operation of entry.operations)if(!operationInputSchemas[operation])throw new Error(`refinement ${id} names unknown operation ${operation}`);
}

function assertAcceptanceConstructAudit(){
  const source=fs.readFileSync(path.join(root,"packages/core/src/operation-contracts.ts"),"utf8");
  const patterns={
    trim:/\.trim\s*\(/g,transform:/\.transform\s*\(/g,preprocess:/z\.preprocess\s*\(/g,pipe:/\.pipe\s*\(/g,
    default:/\.default\s*\(/g,catch:/\.catch\s*\(/g,coerce:/z\.coerce\./g,regex:/\.regex\s*\(/g,
    isoDatetime:/z\.iso\.datetime\s*\(/g,union:/z\.union\s*\(/g,discriminatedUnion:/z\.discriminatedUnion\s*\(/g,
    unknown:/z\.unknown\s*\(/g,strict:/\.strict\s*\(/g,safeExtend:/\.safeExtend\s*\(/g,
    optional:/\.optional\s*\(/g,nullable:/\.nullable\s*\(/g,
    check:/\.check\s*\(/g,custom:/z\.custom(?:\s*<[^>]+>)?\s*\(/g,meta:/\.meta\s*\(/g,
    overwrite:/\.overwrite\s*\(/g,normalize:/\.normalize\s*\(/g,lowercase:/\.lowercase\s*\(/g,
    uppercase:/\.uppercase\s*\(/g,nonempty:/\.nonempty\s*\(/g,length:/\.length\s*\(/g,any:/z\.any\s*\(/g,
  };
  for(const [construct,expected] of Object.entries(operationAcceptanceConstructManifest)){
    const actual=(source.match(patterns[construct])??[]).length;
    if(actual!==expected)throw new Error(`acceptance construct audit drift: ${construct} has ${actual} source sites, manifest declares ${expected}`);
  }
}

function assertSerializedStringAcceptance(operation,input){
  const canonical="^(?!\\s)[\\s\\S]*\\S$(?![\\s\\S])";
  const canonicalPath="^(?!\\s)(?!\\/)(?!.*(?:^|\\/)\\.{1,2}(?:\\/|$))(?!.*\\/\\/)(?!.*\\\\)(?!.*\\/$)[\\s\\S]*\\S$(?![\\s\\S])";
  const canonicalTicketId="^[a-z0-9]+(?:-[a-z0-9]+)*$";
  const nonBlank="^(?=[\\s\\S]*\\S)[\\s\\S]*$";
  walk(input,node=>{
    if(node?.type!=="string"||node.maxLength===undefined)return;
    if(node.maxLength===20_000||node.maxLength===500)return;
    if(![canonical,canonicalPath,canonicalTicketId,nonBlank].includes(node.pattern))throw new Error(`serialized string acceptance drift: ${operation} has bounded non-canonical string ${JSON.stringify(node)}`);
  });
}
