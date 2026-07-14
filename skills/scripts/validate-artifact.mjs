#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { KB, DISTILL } from "./_dispatch.mjs";
import { validateOperationContract } from "./operation-contract-validator.mjs";

const here=path.dirname(fileURLToPath(import.meta.url)); const contracts=path.resolve(here,"../contracts");
function report(schema,errors,warnings=[]){const value={valid:errors.length===0,schema,errors,warnings};process.stdout.write(`${JSON.stringify(value)}\n`);process.exit(value.valid?0:2);}
const args=process.argv.slice(2); const packageIndex=args.indexOf("--package");
if(packageIndex>=0){
  const root=path.resolve(args[packageIndex+1]??path.resolve(here,"..")); const errors=[];
  const skills=["vibehub-ingest","vibehub-query","vibehub-distill","vibehub-update","vibehub-review"];
  for(const skill of skills){
    for(const relative of ["SKILL.md","agents/openai.yaml"])if(!fs.existsSync(path.join(root,skill,relative)))errors.push({path:`${skill}/${relative}`,message:"missing referenced skill asset"});
    const skillPath=path.join(root,skill,"SKILL.md");if(!fs.existsSync(skillPath))continue;
    const source=fs.readFileSync(skillPath,"utf8"),frontmatter=parseFrontmatter(source);
    if(!frontmatter)errors.push({path:`${skill}/SKILL.md`,message:"missing or malformed YAML frontmatter"});
    else{
      if(frontmatter.name!==skill)errors.push({path:`${skill}/SKILL.md`,message:"frontmatter name must match directory"});
      if(!frontmatter.description||frontmatter.description.length<40||!/\buse\b/i.test(frontmatter.description))errors.push({path:`${skill}/SKILL.md`,message:"description must explain capability and when to use it"});
      if(Object.keys(frontmatter).some(key=>!["name","description"].includes(key)))errors.push({path:`${skill}/SKILL.md`,message:"frontmatter contains unsupported keys"});
    }
    for(const line of source.split("\n").filter(line=>line.includes("references/")))if(!/(when|only|before|at the|needed)/i.test(line))errors.push({path:`${skill}/SKILL.md`,message:`method reference is not conditionally loaded: ${line.trim()}`});
    const metadataPath=path.join(root,skill,"agents/openai.yaml");if(fs.existsSync(metadataPath)){
      let parsed;try{parsed=parseRestrictedYaml(fs.readFileSync(metadataPath,"utf8"));}catch(error){errors.push({path:`${skill}/agents/openai.yaml`,message:`invalid restricted YAML: ${error.message}`});parsed={};}
      const metadata=parsed.interface??{},display=metadata.display_name,short=metadata.short_description,prompt=metadata.default_prompt;
      const expected=skill.split("-").map((part,index)=>index===0?"VibeHub":part[0].toUpperCase()+part.slice(1)).join(" ");
      if(display!==expected)errors.push({path:`${skill}/agents/openai.yaml`,message:`display_name must deterministically equal ${expected}`});
      if(!short||short.length<25||short.length>64)errors.push({path:`${skill}/agents/openai.yaml`,message:"short_description must be 25..64 characters"});
      if(!prompt?.includes(`$${skill}`))errors.push({path:`${skill}/agents/openai.yaml`,message:"default_prompt must name the skill"});
    }
    const refsDir=path.join(root,skill,"references");if(fs.existsSync(refsDir))for(const file of fs.readdirSync(refsDir)){
      const ref=fs.readFileSync(path.join(refsDir,file),"utf8");if(/(?:\.\.\/)*(?:_stdlib|contracts|scripts|references)\/[a-z0-9_-]+\.(?:md|json|mjs)/.test(ref))errors.push({path:`${skill}/references/${file}`,message:"method references must not chain-load more resources"});
    }
  }
  for(const file of fs.readdirSync(path.join(root,"_stdlib")))if(!file.endsWith(".md"))errors.push({path:`_stdlib/${file}`,message:"stdlib contains a non-reference asset"});
  const markdown=[]; const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith(".md"))markdown.push(p);}};walk(root);
  const link=/`?((?:\.\.\/)*_stdlib\/[a-z0-9-]+\.md|(?:\.\.\/)*contracts\/[a-z0-9.-]+\.json|(?:\.\.\/)*scripts\/[a-z0-9_-]+\.mjs|references\/[a-z0-9-]+\.md)`?/g;
  for(const file of markdown){const text=fs.readFileSync(file,"utf8");for(const match of text.matchAll(link)){const target=path.resolve(path.dirname(file),match[1]);if(!fs.existsSync(target))errors.push({path:path.relative(root,file),message:`missing reference ${match[1]}`});}}
  const operations=new Set([...KB].map(x=>`kb.${x}`).concat([...DISTILL].map(x=>`distill.${x}`)));
  for(const file of markdown){const source=fs.readFileSync(file,"utf8");for(const match of source.matchAll(/`((?:kb|distill)\.[a-z.-]+)`/g))if(!operations.has(match[1]))errors.push({path:path.relative(root,file),message:`unknown dispatcher operation ${match[1]}`});}
  const operationArtifactPath=path.join(root,"contracts/operation-contracts.json");
  if(fs.existsSync(operationArtifactPath)){
    const artifact=JSON.parse(fs.readFileSync(operationArtifactPath,"utf8"));
    if(artifact.schemaVersion!==4)errors.push({path:"contracts/operation-contracts.json",message:"operation contract schemaVersion must be 4"});
    if(!artifact.scope?.includes("Operation input contracts only"))errors.push({path:"contracts/operation-contracts.json",message:"operation contract must declare its input-only scope"});
    if(!artifact.validationContract?.includes("runtimeRefinements"))errors.push({path:"contracts/operation-contracts.json",message:"operation validation contract must require runtimeRefinements"});
    const expectedConstructs={trim:0,transform:0,preprocess:0,pipe:0,default:0,catch:0,coerce:0,regex:3,isoDatetime:1,union:1,discriminatedUnion:1,unknown:1,strict:55,safeExtend:1,optional:90,nullable:9,check:1,custom:1,meta:1,overwrite:0,normalize:0,lowercase:0,uppercase:0,nonempty:0,length:0,any:0};
    if(JSON.stringify(artifact.acceptanceConstructs)!==JSON.stringify(expectedConstructs))errors.push({path:"contracts/operation-contracts.json",message:"operation acceptance construct audit is missing or stale"});
    const registryHash=crypto.createHash("sha256").update(JSON.stringify(artifact.operations??{})).digest("hex");if(registryHash!==artifact.registryHash)errors.push({path:"contracts/operation-contracts.json",message:"operation registry hash does not match operations"});
    const inputSchemaHash=crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(artifact.operations??{}).map(([name,contract])=>[name,contract.input])))).digest("hex");if(inputSchemaHash!==artifact.inputSchemaHash)errors.push({path:"contracts/operation-contracts.json",message:"operation input acceptance hash does not match serialized schemas"});
    for(const [operation,contract] of Object.entries(artifact.operations??{})){
      const positive=validateOperationContract(contract,contract.fixtures?.positive);if(!positive.valid)errors.push({path:`contracts/operation-contracts.json:${operation}`,message:"positive fixture fails packaged validator"});
      for(const fixture of contract.fixtures?.negatives??[]){const negative=validateOperationContract(contract,fixture.value);if(negative.valid)errors.push({path:`contracts/operation-contracts.json:${operation}`,message:`negative fixture passes packaged validator: ${fixture.case}`});}
    }
  }else errors.push({path:"contracts/operation-contracts.json",message:"missing generated operation contracts"});
  report("skill-package",errors);
}
const operationIndex=args.indexOf("--operation");
if(operationIndex>=0){
  const operation=args[operationIndex+1],inputIndex=args.indexOf("--input"),inputPath=inputIndex>=0?args[inputIndex+1]??"-":"-";
  const artifact=JSON.parse(fs.readFileSync(path.join(contracts,"operation-contracts.json"),"utf8")),contract=artifact.operations?.[operation];
  if(!contract)report(`operation:${operation??""}`,[{path:"$",message:"unknown operation contract"}]);
  let value;try{value=JSON.parse(inputPath==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(inputPath,"utf8"));}catch(error){report(`operation:${operation}`,[{path:"$",message:`invalid JSON: ${error instanceof Error?error.message:String(error)}`}]);}
  const result=validateOperationContract(contract,value);report(`operation:${operation}`,result.errors);
}
let schemaName,inputPath="-";
for(let i=0;i<args.length;i++){const f=args[i];if(f==="--schema")schemaName=args[++i];else if(f==="--input")inputPath=args[++i];else report("arguments",[{path:"$",message:`unknown argument ${f}`}]);}
if(!schemaName)report("arguments",[{path:"$",message:"--schema is required"}]);
const file=schemaName.endsWith(".json")?schemaName:`${schemaName}.schema.json`; const schemaPath=path.join(contracts,file);
if(!fs.existsSync(schemaPath))report(file,[{path:"$",message:"unknown schema"}]);
let value;try{value=JSON.parse(inputPath==="-"?fs.readFileSync(0,"utf8"):fs.readFileSync(inputPath,"utf8"));}catch(error){report(file,[{path:"$",message:`invalid JSON: ${error instanceof Error?error.message:String(error)}`}]);}
const schema=JSON.parse(fs.readFileSync(schemaPath,"utf8")); const errors=[];
validate(schema,value,"$",schema,errors);if(errors.length===0)validateWorkflowRefinements(file,value,errors);report(file,errors);

function validateWorkflowRefinements(file,value,errors){
  const canonical=value=>typeof value==="string"&&value.length>0&&value===value.trim()&&!value.startsWith("/")&&!value.endsWith("/")&&!value.includes("\\")&&!value.includes("//")&&!value.split("/").some(part=>part==="."||part==="..");
  if(file==="distillation-scope.schema.json"){
    const files=value.files??[],covered=value.coveredFiles??[],unresolved=(value.unresolvedFiles??[]).map(item=>item.path),all=[...covered,...unresolved];
    for(const [label,paths] of [["files",files],["coveredFiles",covered],["unresolvedFiles",unresolved]]){
      if(paths.some(path=>!canonical(path)))errors.push({path:`$.${label}`,message:"paths must be canonical repo-relative paths"});
      if(new Set(paths).size!==paths.length)errors.push({path:`$.${label}`,message:"paths must be unique by canonical path"});
    }
    const owned=new Set(files);if(all.some(path=>!owned.has(path)))errors.push({path:"$",message:"covered and unresolved paths must be owned by files"});
    if(new Set(all).size!==all.length)errors.push({path:"$",message:"covered and unresolved paths must be disjoint"});
    if(all.length!==files.length||files.some(path=>!all.includes(path)))errors.push({path:"$",message:"every file must be disposed exactly once as covered or unresolved"});
  }
  if(file==="distillation-result.schema.json"){
    const accounting=value.accounting??{},dispositions=value.unresolvedDispositions??[];
    if(accounting.inventory!==accounting.excluded+accounting.covered+accounting.unresolved)errors.push({path:"$.accounting",message:"inventory must equal excluded + covered + unresolved"});
    const paths=dispositions.map(item=>item.path);if(paths.some(path=>!canonical(path)))errors.push({path:"$.unresolvedDispositions",message:"paths must be canonical repo-relative paths"});
    if(new Set(paths).size!==paths.length)errors.push({path:"$.unresolvedDispositions",message:"unresolved disposition paths must be unique"});
    if(paths.length!==accounting.unresolved)errors.push({path:"$.unresolvedDispositions",message:"disposition count must equal accounting.unresolved"});
  }
}

function validate(s,v,p,root,errors){
  if(s.$ref){const target=s.$ref.split("/").slice(1).reduce((x,k)=>x?.[k.replaceAll("~1","/").replaceAll("~0","~")],root);return validate(target,v,p,root,errors);}
  if(s.anyOf&&!s.anyOf.some(candidate=>{const local=[];validate(candidate,v,p,root,local);return local.length===0;}))errors.push({path:p,message:"does not match any allowed shape"});
  if(s.enum&&!s.enum.includes(v))errors.push({path:p,message:`must be one of ${s.enum.join(", ")}`});
  const types=Array.isArray(s.type)?s.type:[s.type]; if(s.type&&!types.some(t=>isType(t,v))){errors.push({path:p,message:`must be ${types.join(" or ")}`});return;}
  if(typeof v==="string"){if(s.minLength!==undefined&&v.length<s.minLength)errors.push({path:p,message:"string too short"});if(s.maxLength!==undefined&&v.length>s.maxLength)errors.push({path:p,message:"string too long"});}
  if(typeof v==="number"){if(s.minimum!==undefined&&v<s.minimum)errors.push({path:p,message:"number below minimum"});if(s.maximum!==undefined&&v>s.maximum)errors.push({path:p,message:"number above maximum"});}
  if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems)errors.push({path:p,message:"too few items"});if(s.maxItems!==undefined&&v.length>s.maxItems)errors.push({path:p,message:"too many items"});if(s.uniqueItems&&new Set(v.map(JSON.stringify)).size!==v.length)errors.push({path:p,message:"items must be unique"});if(s.items)v.forEach((x,i)=>validate(s.items,x,`${p}[${i}]`,root,errors));}
  if(v&&typeof v==="object"&&!Array.isArray(v)){for(const key of s.required??[])if(!(key in v))errors.push({path:`${p}.${key}`,message:"required"});for(const [key,dependencies] of Object.entries(s.dependentRequired??{}))if(key in v)for(const dependency of dependencies)if(!(dependency in v))errors.push({path:`${p}.${dependency}`,message:`required when ${key} is present`});if(s.additionalProperties===false)for(const key of Object.keys(v))if(!(key in (s.properties??{})))errors.push({path:`${p}.${key}`,message:"unexpected property"});for(const [key,sub] of Object.entries(s.properties??{}))if(key in v)validate(sub,v[key],`${p}.${key}`,root,errors);}
}
function isType(t,v){return t==="null"?v===null:t==="array"?Array.isArray(v):t==="object"?Boolean(v)&&typeof v==="object"&&!Array.isArray(v):t==="integer"?Number.isInteger(v):typeof v===t;}

function parseFrontmatter(source){
  const match=/^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);if(!match)return null;
  try{return parseRestrictedYaml(match[1]);}catch{return null;}
}

/** Parse the mapping/string subset used by skill frontmatter and openai.yaml. */
function parseRestrictedYaml(source){
  const lines=source.split(/\r?\n/),root={},stack=[{indent:-1,value:root}];
  for(let i=0;i<lines.length;i++){
    const raw=lines[i];if(!raw.trim()||raw.trimStart().startsWith("#"))continue;if(raw.includes("\t"))throw new Error("tabs are not allowed");
    const indent=raw.length-raw.trimStart().length,match=/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s*(.*))?$/.exec(raw.trim());if(!match)throw new Error(`unsupported YAML at line ${i+1}`);
    while(stack.at(-1).indent>=indent)stack.pop();const parent=stack.at(-1)?.value;if(!parent||typeof parent!=="object")throw new Error(`invalid indentation at line ${i+1}`);
    const key=match[1],token=match[2]??"";if(Object.hasOwn(parent,key))throw new Error(`duplicate key ${key}`);
    if(token===""){const child={};parent[key]=child;stack.push({indent,value:child});continue;}
    if(token==="|"||token===">"){
      const parts=[];let next=i+1;for(;next<lines.length;next++){const line=lines[next],lineIndent=line.length-line.trimStart().length;if(line.trim()&&lineIndent<=indent)break;parts.push(line.trim()?line.slice(Math.min(line.length,indent+2)):"");}
      parent[key]=token==="|"?parts.join("\n"):parts.join(" ").replace(/\s+/g," ").trim();i=next-1;continue;
    }
    parent[key]=yamlScalar(token,i+1);
  }
  return root;
}
function yamlScalar(token,line){
  if(token.startsWith('"')){try{const value=JSON.parse(token);if(typeof value!=="string")throw new Error();return value;}catch{throw new Error(`invalid quoted scalar at line ${line}`);}}
  if(token.startsWith("'")){if(!token.endsWith("'"))throw new Error(`invalid quoted scalar at line ${line}`);return token.slice(1,-1).replaceAll("''", "'");}
  if(/^[\[{&*!]/.test(token))throw new Error(`unsupported YAML construct at line ${line}`);
  if(token==="true"||token==="false")return token==="true";if(token==="null")return null;
  return token;
}
