import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureCommand } from "./_capture.mjs";
import {
  OPERATION_INPUT_BYTE_LIMITS,
} from "./generated-operation-limits.mjs";

export const KB = new Set(["status","feature.list","feature.get","feature.suggest","spec.search","spec.get","relations","lineage","anchors","review","ingest.preview","spec.apply","mark-stale","deprecate","amend","supersede"]);
export const DISTILL = new Set(["run.start","run.status","run.resume","run.abort","inventory.put","inventory.get","inventory.diff","inventory.seal","scopes.plan","scopes.claim","scopes.complete","scopes.fail","scopes.retry","scopes.correct","candidates.put","candidates.get","candidates.list","baseline.get","version.get","version.diff","reconcile","validate","finalize","activate","rollback"]);
export const TICKET = new Set([
  "graph.snapshot",
  "subject.inspect",
  "trace.list",
]);

function fail(message, code = "validation_error", exit = 2) {
  fs.writeSync(1,`${JSON.stringify({ok:false,error:{code,message,details:null,nextSafeActions:["Correct the request and retry."]}})}\n`);
  process.exit(exit);
}

export async function run(group, registry, argv) {
  const operation = argv.shift();
  const shortOperation = operation?.replace(new RegExp(`^${group}\\.`), "");
  if (!operation || !shortOperation || !registry.has(shortOperation)) fail(`unsupported ${group} operation: ${operation ?? ""}`);
  let inputPath = "-"; const forwarded = [];
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==="--input") inputPath=argv[++i] ?? fail("--input needs a file or -");
    else if(["--repo","--db","--repo-id","--actor","--task","--request"].includes(flag)) {
      const value=argv[++i]; if(value===undefined) fail(`${flag} needs a value`); forwarded.push(flag,value);
    } else fail(`unknown flag: ${flag}`);
  }
  let raw="{}";
  try {
    raw=readUtf8Input(
      inputPath,
      OPERATION_INPUT_BYTE_LIMITS[`${group}.${shortOperation}`],
    ).trim()||"{}";
    JSON.parse(raw);
  }
  catch(error){ fail(`invalid JSON input: ${error instanceof Error?error.message:String(error)}`); }
  const invocation=resolveVibehubInvocation();
  const child=await captureCommand(
    invocation.command,
    [...invocation.prefix,group,operation,"--json",...forwarded,"--input","-"],
    {input:raw,env:process.env},
  );
  if(child.kind==="overflow")fail(`vibehub CLI response exceeded ${child.limit} bytes`,"response_too_large",1);
  if(child.kind==="spawn_error")fail(`cannot execute vibehub CLI: ${child.error.message}`,"internal_error",1);
  if(child.kind==="signal")fail(`vibehub CLI terminated by signal ${child.signal}`,"cli_terminated",1);
  const output=child.stdout.trim();
  try { JSON.parse(output); } catch {
    const detail=diagnostic(child.stderr||child.stdout);
    fail(
      `vibehub CLI returned a non-JSON response${detail?`: ${detail}`:""}`,
      "internal_error",
      1,
    );
  }
  // Synchronous final emission makes an immediate, intentional process exit
  // safe even when the wrapper itself is captured through a pipe.
  fs.writeSync(1,`${output}\n`);
  process.exit(child.status);
}

export function resolveVibehubInvocation() {
  if(process.env.VIBEHUB_BIN){
    return {command:process.env.VIBEHUB_BIN,prefix:[]};
  }
  const here=path.dirname(fileURLToPath(import.meta.url));
  const localCandidates=[
    path.resolve(here,"../../../main.js"),
    path.resolve(here,"../../packages/cli/dist/main.js"),
  ];
  const local=localCandidates.find(candidate=>fs.statSync(
    candidate,
    {throwIfNoEntry:false},
  )?.isFile());
  return local
    ? {command:process.execPath,prefix:[local]}
    : {command:"vibehub",prefix:[]};
}

function diagnostic(value) {
  return value.trim().replace(/\s+/g," ").slice(0,400);
}

function readUtf8Input(inputPath, maximumBytes) {
  const source=inputPath==="-"?0:fs.openSync(inputPath,"r");
  const close=inputPath!=="-";
  try {
    if(maximumBytes===undefined)return fs.readFileSync(source,"utf8");
    const chunks=[];let byteLength=0;const buffer=Buffer.allocUnsafe(64*1024);
    while(true){
      const count=fs.readSync(source,buffer,0,buffer.length,null);
      if(count===0)break;
      byteLength+=count;
      if(byteLength>maximumBytes)throw new Error(`operation raw JSON input exceeds ${maximumBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0,count)));
    }
    return Buffer.concat(chunks,byteLength).toString("utf8");
  } finally {
    if(close)fs.closeSync(source);
  }
}
