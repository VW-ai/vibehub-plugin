#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function die(message){process.stdout.write(`${JSON.stringify({ok:false,error:{code:"inventory_error",message,details:null,nextSafeActions:["Run inside a readable Git repository."]}})}\n`);process.exit(2);}
let repo=process.cwd(),runId,baseCommit,targetCommit,diagnostics=false;
for(let i=2;i<process.argv.length;i++){const flag=process.argv[i];if(flag==="--diagnostics"){diagnostics=true;continue;}if(!["--repo","--run-id","--base-commit","--target-commit"].includes(flag))die(`unknown argument: ${flag}`);const value=process.argv[++i];if(!value||value.startsWith("--"))die(`missing value for ${flag}`);if(flag==="--repo")repo=value;else if(flag==="--run-id")runId=value;else if(flag==="--base-commit")baseCommit=value;else targetCommit=value;}
if(!runId)die("--run-id is required");if(targetCommit&&!baseCommit)die("--target-commit requires --base-commit");
const rootResult=spawnSync("git",["-C",repo,"rev-parse","--show-toplevel"],{encoding:"utf8"});if(rootResult.status!==0)die("repository is not a Git worktree");const root=fs.realpathSync(rootResult.stdout.trim());
const git=(args,encoding="buffer")=>spawnSync("git",["-C",root,...args],{encoding,maxBuffer:64*1024*1024});
const resolveCommit=value=>{const result=git(["rev-parse","--verify",`${value}^{commit}`],"utf8");if(result.status!==0)die(`${value===baseCommit?"base":"target"} commit is not a commit in this repository`);return result.stdout.trim();};
const excludedNames=new Set([".git"]),excludedSegments=new Set(["node_modules","dist","build","coverage",".next","vendor"]);
const hash=content=>crypto.createHash("sha256").update(content).digest("hex");
const compareRepoPaths=(a,b)=>Buffer.compare(Buffer.from(a,"utf8"),Buffer.from(b,"utf8"));
const classify=(relative,content,change={})=>{if(change.changeKind==="deleted")return {path:relative,classification:"excluded",reason:"incremental_deleted",...change};if(change.changeKind==="unchanged")return {path:relative,classification:"excluded",reason:"incremental_unchanged",contentHash:hash(content),...change};const segments=relative.split("/"),contentHash=hash(content);if(segments.some(x=>excludedNames.has(x)||excludedSegments.has(x)))return {path:relative,classification:"excluded",reason:"generated_or_dependency",contentHash,...change};if(content.length>2_000_000)return {path:relative,classification:"excluded",reason:"oversize_file",contentHash,...change};if(content.includes(0))return {path:relative,classification:"excluded",reason:"binary_file",contentHash,...change};return {path:relative,classification:"included",contentHash,...change};};
const classifyTreeEntry=(entry,content,change)=>entry.mode==="100644"||entry.mode==="100755"?classify(entry.path,content,change):{path:entry.path,classification:"excluded",reason:"non_regular_file",contentHash:hash(content),...change};

let rows=[];
if(!baseCommit){const listed=git(["ls-files","-z","--cached","--others","--exclude-standard"]);if(listed.status!==0)die("git inventory failed");for(const relative of listed.stdout.toString("utf8").split("\0").filter(Boolean).sort(compareRepoPaths)){const absolute=path.join(root,relative);let stat;try{stat=fs.lstatSync(absolute);}catch{rows.push({path:relative,classification:"excluded",reason:"non_regular_file"});continue;}if(!stat.isFile()||stat.isSymbolicLink()){rows.push({path:relative,classification:"excluded",reason:"non_regular_file"});continue;}let content;try{content=fs.readFileSync(absolute);}catch{rows.push({path:relative,classification:"excluded",reason:"non_regular_file"});continue;}rows.push(classify(relative,content));}}
else{
  baseCommit=resolveCommit(baseCommit);
  if(!targetCommit){const status=git(["status","--porcelain=v1","--untracked-files=all"],"utf8");if(status.status!==0)die("git status failed");if(status.stdout.trim())die("incremental inventory requires a clean HEAD or explicit --target-commit");targetCommit=git(["rev-parse","--verify","HEAD"],"utf8").stdout.trim();}
  targetCommit=resolveCommit(targetCommit);
  const tree=git(["ls-tree","-r","-z",targetCommit]);if(tree.status!==0)die("target inventory failed");const targetEntries=tree.stdout.toString("utf8").split("\0").filter(Boolean).map(record=>{const tab=record.indexOf("\t");if(tab<0)die("malformed target tree entry");const [mode,type,object]=record.slice(0,tab).split(" ");return {mode,type,object,path:record.slice(tab+1)};}).sort((a,b)=>compareRepoPaths(a.path,b.path));
  const diff=git(["diff","--name-status","-z","-M",baseCommit,targetCommit,"--"]);if(diff.status!==0)die("git delta failed");const parts=diff.stdout.toString("utf8").split("\0").filter(Boolean),delta=new Map();for(let i=0;i<parts.length;){const status=parts[i++];if(status.startsWith("R")){const previousPath=parts[i++],nextPath=parts[i++];delta.set(nextPath,{changeKind:"renamed",previousPath});}else{const relative=parts[i++];delta.set(relative,{changeKind:status.startsWith("A")?"added":status.startsWith("D")?"deleted":"modified"});}}
  for(const entry of targetEntries){const objectContent=entry.type==="blob"?git(["cat-file","blob",entry.object]):{status:0,stdout:Buffer.from(entry.object,"utf8")};if(objectContent.status!==0)die(`cannot read target object: ${entry.path}`);rows.push(classifyTreeEntry(entry,objectContent.stdout,delta.get(entry.path)??{changeKind:"unchanged"}));}
  for(const [relative,change] of delta)if(change.changeKind==="deleted")rows.push(classify(relative,Buffer.alloc(0),change));
}
rows.sort((a,b)=>compareRepoPaths(a.path,b.path));
process.stdout.write(`${JSON.stringify({runId,rows})}\n`);
if(diagnostics)process.stderr.write(`${JSON.stringify({baseCommit:baseCommit??null,targetCommit:targetCommit??null})}\n`);
