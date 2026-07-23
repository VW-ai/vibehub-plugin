import fs from "node:fs";
import { captureCommand } from "./_capture.mjs";

export const KB = new Set(["status","feature.list","feature.get","feature.suggest","spec.search","spec.get","relations","lineage","anchors","review","ingest.preview","draft.apply","promote","mark-stale","deprecate","amend","supersede"]);
export const DISTILL = new Set(["run.start","run.status","run.resume","run.abort","inventory.put","inventory.get","inventory.diff","inventory.seal","scopes.plan","scopes.claim","scopes.complete","scopes.fail","scopes.retry","scopes.correct","candidates.put","candidates.get","candidates.list","baseline.get","version.get","version.diff","reconcile","validate","finalize","activate","rollback"]);

function fail(message, code = "validation_error", exit = 2) {
  fs.writeSync(1,`${JSON.stringify({ok:false,error:{code,message,details:null,nextSafeActions:["Correct the request and retry."]}})}\n`);
  process.exit(exit);
}

export async function run(group, registry, argv) {
  const operation = argv.shift();
  if (!operation || !registry.has(operation.replace(new RegExp(`^${group}\\.`), ""))) fail(`unsupported ${group} operation: ${operation ?? ""}`);
  let inputPath = "-"; const forwarded = [];
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==="--input") inputPath=argv[++i] ?? fail("--input needs a file or -");
    else if(["--repo","--db","--repo-id","--actor","--task","--request"].includes(flag)) {
      const value=argv[++i]; if(value===undefined) fail(`${flag} needs a value`); forwarded.push(flag,value);
    } else fail(`unknown flag: ${flag}`);
  }
  let raw="{}";
  try { raw=fs.readFileSync(inputPath==="-"?0:inputPath,"utf8").trim()||"{}"; JSON.parse(raw); }
  catch(error){ fail(`invalid JSON input: ${error instanceof Error?error.message:String(error)}`); }
  const binary=process.env.VIBEHUB_BIN || "vibehub";
  const child=await captureCommand(binary,[group,operation,"--json",...forwarded,"--input","-"],{input:raw,env:process.env});
  if(child.kind==="overflow")fail(`vibehub CLI response exceeded ${child.limit} bytes`,"response_too_large",1);
  if(child.kind==="spawn_error")fail(`cannot execute vibehub CLI: ${child.error.message}`,"internal_error",1);
  if(child.kind==="signal")fail(`vibehub CLI terminated by signal ${child.signal}`,"cli_terminated",1);
  const output=child.stdout.trim();
  try { JSON.parse(output); } catch { fail("vibehub CLI returned a non-JSON response","internal_error",1); }
  // Synchronous final emission makes an immediate, intentional process exit
  // safe even when the wrapper itself is captured through a pipe.
  fs.writeSync(1,`${output}\n`);
  process.exit(child.status);
}
