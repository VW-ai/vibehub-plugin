import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { operationAcceptanceConstructManifest, operationInputSchemas, operationRefinementManifest } from "@vibehub/core";
import { validateOperationContract, validateRuntimeRefinements } from "../../../skills/scripts/operation-contract-validator.mjs";

const EXPECTED_INPUT_SCHEMA_HASH="a337e4239097e1f85cfea2e9e35d8159bd898162d252190542030f855c8eb82e";

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
  for(const fixture of negatives)if(!fixture.value||typeof fixture.value!=="object"||Array.isArray(fixture.value)||JSON.stringify(fixture.value)===JSON.stringify(positive)||!fixture.case||!Array.isArray(fixture.refinementIds))throw new Error(`trivial negative fixture: ${name}`);
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
  operations[name]={input,runtimeRefinements,fixtures:{positive,negative:negatives[0].value,negativeCase:negatives[0].case,negatives}};
}

const inputSchemaHash=crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(operations).map(([name,contract])=>[name,contract.input])))).digest("hex");
if(inputSchemaHash!==EXPECTED_INPUT_SCHEMA_HASH)throw new Error(`operation input acceptance fingerprint changed: expected ${EXPECTED_INPUT_SCHEMA_HASH}, got ${inputSchemaHash}; review the full serialized diff before updating the explicit fingerprint`);
const registryHash=crypto.createHash("sha256").update(JSON.stringify(operations)).digest("hex");
const artifact={
  schemaVersion:4,registryHash,inputSchemaHash,
  dialect:"JSON Schema 2020-12 plus VibeHub runtimeRefinements/v1",
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
  return schema;
}

function runtimeRefinementsFor(name){
  const rules=[];
  if(["kb.ingest.preview","kb.draft.apply","kb.amend","distill.candidates.put"].includes(name))rules.push({id:"anchor-line-range",kind:"fieldCompare",matchFields:["lineStart","lineEnd"],leftField:"lineEnd",operator:"gte",rightField:"lineStart",message:"lineEnd must not precede lineStart"});
  if(name==="distill.candidates.put")rules.push({id:"relation-distinct-endpoints",kind:"fieldCompare",matchFields:["fromKind","fromId","toKind","toId"],leftField:"fromId",operator:"notEqual",rightField:"toId",message:"relation endpoints must differ"});
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
  const fixtures={
    "kb.status":{},"kb.feature.list":{query:"two words"},"kb.feature.get":{id:"x".repeat(200)},"kb.feature.suggest":{},
    "kb.spec.search":{paths:["src/two words.ts"],tags:["two words"]},"kb.spec.get":{id:specId},"kb.relations":{specId},"kb.lineage":{id:specId},"kb.anchors":{specId},"kb.review":{},
    "kb.ingest.preview":{specs:[{summary:"Fixture fact"}]},
    "kb.draft.apply":{idempotencyKey:key,specs:[{id:specId,type:"context",summary:"Fixture fact",evidence:[{sourceType:"fixture",sourceRef:"fixture:1",exactQuote:"quoted evidence",evidenceRef:"fixture:1"}]}]},
    "kb.promote":{specId,idempotencyKey:key},"kb.mark-stale":{specId,idempotencyKey:key},"kb.deprecate":{specId,idempotencyKey:key},
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
    "kb.draft.apply":[
      fixture("evidence requires content",{...positive,specs:[{...positive.specs?.[0],evidence:[{sourceType:"fixture",sourceRef:"fixture:1"}]}]},["evidence-content"]),
      fixture("draft anchor lineEnd requires lineStart",{...positive,specs:[{...positive.specs?.[0],anchors:[{file:"src/a.ts",lineEnd:2}]}]},["anchor-line-range"]),
      fixture("draft anchor lineEnd order",{...positive,specs:[{...positive.specs?.[0],anchors:[{file:"src/a.ts",lineStart:3,lineEnd:2}]}]},["anchor-line-range"]),
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
  };
  if(explicit[name])return explicit[name];
  const value=structuredClone(positive);
  const required=input.required??[];
  if(required.length){delete value[required[0]];return [fixture(`missing required ${required[0]}`,value)];}
  value._unexpected=true;
  return [fixture("strict object rejects extra property",value)];
}

function fixture(caseName,value,refinementIds=[]){return {case:caseName,value,refinementIds};}

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
    "candidate-selector-exactly-one":{representation:"json-schema",mechanism:"oneOf required runId/versionId with not"},
    "candidate-discriminated-union":{representation:"json-schema",mechanism:"oneOf strict kind-const branches"},
    "anchors-strict-union":{representation:"json-schema",mechanism:"anyOf strict single-property branches"},
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
  walk(input,node=>{
    if(node?.type!=="string"||node.maxLength===undefined)return;
    if(node.maxLength===20_000||node.maxLength===500)return;
    if(node.pattern!==canonical&&node.pattern!==canonicalPath)throw new Error(`serialized string acceptance drift: ${operation} has bounded non-canonical string ${JSON.stringify(node)}`);
  });
}
