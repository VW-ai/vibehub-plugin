#!/usr/bin/env node
/**
 * vibehub — thin CLI over @vibehub/core (decision-project-013: the CLI does
 * argument parsing and output formatting ONLY; every real operation is one
 * core call. Zero LLM, zero API keys.)
 *
 * Commands:
 *   vibehub hook <event>                              (M1 ③ — the heart)
 *   vibehub inject <task-id> <text> [--mode inject|pause] [--context <locus>]
 *   vibehub team sync    [--repo <path>] [--db <path>] [--json]
 *   vibehub team snapshot [--repo <path>] [--db <path>] [--out <file>]
 *
 * `vibehub hook` reads the Claude Code hook payload from stdin, does one
 * short-lived pass (write event → claim injection queue → exit 0) and
 * NEVER fails the session: any error is swallowed to ~/.vibehub/hook.log.
 * DB override: --db or VIBEHUB_DB (hooks configs use env, not flags).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import {
  applyIntervention,
  CURRENT_SCHEMA_VERSION,
  exportTeamMapSnapshot,
  GitFacade,
  ingestCanonicalHookEvent,
  migrateSqliteSemanticStoreToGit,
  openDb,
  projectDoctorReceipt,
  projectInitReceipt,
  projectInjectionInterventionReceipt,
  readTask,
  renderWorkflowReceiptText,
  resolveDbPath,
  RuntimeService,
  OperationDispatcher,
  OPERATION_EXIT_CLASS,
  syncTeamSnapshot,
  vibehubHome,
  type HookEventName,
  type HookHost,
  type WorkbenchIntervention,
} from "@vibehub/core";
import { releaseAssetManifest, releaseAssetRoot } from "./managed-assets.js";
import { adaptHookInput, projectHookOutput } from "./hook-adapters.js";

interface Flags {
  repo: string;
  /** Resolved DB path: explicit --db > VIBEHUB_DB > default (core policy). */
  db: string;
  out?: string;
  json: boolean;
}

function parseFlags(argv: string[], failureMode: "exit" | "throw" = "exit"): Flags {
  let dbFlag: string | undefined;
  const flags = { repo: process.cwd(), out: undefined as string | undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") flags.repo = argv[++i] ?? flags.repo;
    else if (a === "--db") dbFlag = argv[++i];
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--json") flags.json = true;
    else {
      if (failureMode === "throw") throw new Error(`unknown flag: ${a}`);
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return { ...flags, db: resolveDbPath(dbFlag) };
}

function parseSetupFlags(argv: string[]): Flags {
  let repo = process.cwd();
  let dbFlag: string | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag ?? "")) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag ?? "");
    if (flag === "--json") json = true;
    else if (flag === "--repo" || flag === "--db") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--repo") repo = value;
      else dbFlag = value;
    } else {
      throw new Error(`unknown flag: ${flag}`);
    }
  }
  return { repo, db: resolveDbPath(dbFlag), json };
}

const USAGE = `usage:
  vibehub init [--repo <path>] [--db <path>] [--json]
  vibehub setup inspect|apply|status [--repo <path>] [--db <path>] [--json]
  vibehub doctor [--json] [--repo <path>] [--db <path>]
  vibehub snapshot|inspect [--repo <path>] [--db <path>] [--out <file>]
  vibehub kb <operation> --json [--input <json>] [--actor <id>] [--task <id>] [--request <id>]
  vibehub kb migrate-store --json [--repo <path>] [--db <path>]
  vibehub distill <operation> --json [--input <json>] [--actor <id>] [--task <id>] [--request <id>]
  vibehub hook <SessionStart|UserPromptSubmit|PostToolUse|PostToolUseFailure|Notification|Stop|StopFailure|SessionEnd|SubagentStart|SubagentStop> [--host claude-code|codex]
  vibehub inject <task-id> <text> [--mode inject|pause] [--context <locus>] [--request <id>] [--json] [--db <path>]
  vibehub team sync    [--repo <path>] [--db <path>] [--json]
  vibehub team snapshot [--repo <path>] [--db <path>] [--out <file>]`;

interface KbCliFlags {
  db:string; repo:string; repoId?:number; actor?:string; taskId?:string; requestId:string;
  input:Record<string,unknown>; json:boolean;
}

function parseKbFlags(argv:string[]):KbCliFlags {
  let dbFlag:string|undefined; let repo=process.cwd(); let repoId:number|undefined;
  let actor:string|undefined; let taskId:string|undefined; let requestId=`cli-${Date.now()}`;
  let inputText:string|undefined; let json=false;
  for(let i=0;i<argv.length;i++){
    const flag=argv[i]; const take=()=>argv[++i];
    if(flag==="--db")dbFlag=take(); else if(flag==="--repo")repo=take()??repo;
    else if(flag==="--repo-id")repoId=Number(take()); else if(flag==="--actor")actor=take();
    else if(flag==="--task")taskId=take(); else if(flag==="--request")requestId=take()??requestId;
    else if(flag==="--input")inputText=take(); else if(flag==="--json")json=true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  if(inputText==="-"){const stdin=readStdin().trim();inputText=stdin||"{}";}
  const input=inputText?JSON.parse(inputText) as Record<string,unknown>:{};
  return {db:resolveDbPath(dbFlag),repo,repoId,actor,taskId,requestId,input,json};
}

function runOperation(group:"kb"|"distill",operation:string|undefined,argv:string[]):number {
  let db:ReturnType<typeof openDb>|undefined;
  try{
    if(!operation)throw new Error("KB operation is required");
    const flags=parseKbFlags(argv); if(!flags.json)throw new Error("kb operations require --json");
    db=openDb(flags.db);
    const session=GitFacade.sessionContextAt(flags.repo);
    const root=session.repoRoot;
    const row=flags.repoId?{id:flags.repoId}:db.prepare(`SELECT id FROM repos WHERE root_path=?`).get(root) as {id:number}|undefined;
    const repoId=row?.id??0;
    const canonicalOperation=operation.startsWith("kb.")||operation.startsWith("distill.")?operation:`${group}.${operation}`;
    const result=new OperationDispatcher(db,{repoRoot:session.toplevel}).dispatch(canonicalOperation,{repoId,actor:flags.actor??"",taskId:flags.taskId,requestId:flags.requestId,now:new Date().toISOString()},flags.input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok?0:(OPERATION_EXIT_CLASS[result.error.code]??1);
  }catch(error){const result={ok:false,error:{code:"validation_error",message:error instanceof Error?error.message:String(error),details:null,nextSafeActions:[`Run vibehub ${group} with --json and a valid JSON --input payload.`]}};process.stdout.write(`${JSON.stringify(result)}\n`);return 2;}finally{db?.close();}
}

function runSemanticMigration(argv:string[]):number{
  const flags=parseFlags(argv,"throw");
  if(!flags.json)throw new Error("kb migrate-store requires --json");
  const session=GitFacade.sessionContextAt(flags.repo);
  const db=openDb(flags.db);
  let locked=false;
  try{
    const repo=db.prepare(`SELECT id FROM repos WHERE root_path=?`).get(session.repoRoot) as {id:number}|undefined;
    if(!repo)throw new Error("repository is not initialized in VibeHub; run vibehub init first");
    const backupDirectory=path.join(path.dirname(flags.db),"backups","git-semantic-store");
    fs.mkdirSync(backupDirectory,{recursive:true});
    const stamp=new Date().toISOString().replaceAll(":","-");
    const backupPath=path.join(backupDirectory,`${repo.id}-${stamp}.db`);
    const before=Number(db.pragma("data_version",{simple:true}));
    db.prepare("VACUUM INTO ?").run(backupPath);
    db.exec("BEGIN IMMEDIATE");locked=true;
    const after=Number(db.pragma("data_version",{simple:true}));
    if(after!==before)throw new Error("SQLite changed while the migration backup was being created");
    const migrated=migrateSqliteSemanticStoreToGit({
      sourceDbPath:flags.db,
      sourceRepoId:repo.id,
      repoRoot:session.toplevel,
    });
    db.prepare(`INSERT INTO repo_semantic_authority(repo_id,format,initial_semantic_digest,cutover_at)
      VALUES(?,'git-semantic-store',?,?)`).run(repo.id,migrated.semanticDigest,new Date().toISOString());
    db.exec("COMMIT");locked=false;
    const receipt={
      schemaVersion:1,
      operation:"kb.migrate-store",
      repoId:repo.id,
      repoRoot:session.repoRoot,
      worktree:session.toplevel,
      sourceSchemaVersion:CURRENT_SCHEMA_VERSION,
      backupPath,
      backupSha256:crypto.createHash("sha256").update(fs.readFileSync(backupPath)).digest("hex"),
      semanticDigest:migrated.semanticDigest,
      featureCount:migrated.featureCount,
      specCount:migrated.specCount,
      provenanceCount:migrated.provenanceCount,
      storePath:migrated.storePath,
    };
    process.stdout.write(`${JSON.stringify({ok:true,data:receipt})}\n`);
    return 0;
  }catch(error){
    if(locked){try{db.exec("ROLLBACK");}catch{/* preserve the original migration error */}}
    process.stdout.write(`${JSON.stringify({ok:false,error:{code:"migration_failed",message:error instanceof Error?error.message:String(error)}})}\n`);
    return 1;
  }finally{db.close();}
}

const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
]);

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * The heart (decision-project-025). Exit 0 ALWAYS — a hook must never
 * break the user's session; failures go to ~/.vibehub/hook.log.
 */
function runHook(eventArg: string | undefined, rest: string[]): number {
  let host: HookHost = "claude-code";
  try {
    const filtered: string[] = [];
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index];
      if (flag === "--host") {
        const value = rest[++index];
        if (value !== "claude-code" && value !== "codex") {
          throw new Error("--host must be claude-code or codex");
        }
        host = value;
      } else {
        filtered.push(flag!);
      }
    }
    const dbPath = parseFlags(filtered, "throw").db;
    const raw = readStdin();
    const payload = JSON.parse(raw) as unknown;
    const payloadEvent = typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)["hook_event_name"]
      : undefined;
    const event = (eventArg ?? payloadEvent) as HookEventName;
    if (!HOOK_EVENTS.has(event)) throw new Error(`unknown hook event: ${event}`);
    const adapted = adaptHookInput(host, event, payload);
    if (adapted.kind === "ignored") return 0;
    const db = openDb(dbPath);
    try {
      const result = ingestCanonicalHookEvent(db, adapted.event);
      if (result.delivery) console.log(JSON.stringify(projectHookOutput(host, result.delivery)));
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      const logDir = vibehubHome();
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "hook.log"),
        `${new Date().toISOString()} ${host}:${eventArg ?? "?"} ${String(err)}\n`,
      );
    } catch {
      // even logging must not fail the session
    }
  }
  return 0;
}

function stateDirFor(dbPath: string): string {
  return process.env["VIBEHUB_STATE_DIR"] ?? path.dirname(dbPath);
}

/**
 * Human (non---json) surfaces render the shared workflow receipt as plain
 * five-section text: same semantic truth as the JSON evidence, sized to the
 * terminal, readable without ANSI (decision-workbench-016).
 */
function renderReceipt(receipt: Parameters<typeof renderWorkflowReceiptText>[0]): string {
  return renderWorkflowReceiptText(receipt, { width: process.stdout.columns ?? 80 });
}

function printSnapshot(flags: Flags): number {
  const db = openDb(flags.db);
  try {
    const snapshot = exportTeamMapSnapshot(db, GitFacade.resolveRepoRoot(flags.repo));
    const json = JSON.stringify(snapshot, null, 2);
    if (flags.out) {
      fs.mkdirSync(path.dirname(flags.out), { recursive: true });
      fs.writeFileSync(flags.out, json + "\n");
      console.error(`wrote ${flags.out}`);
    } else {
      console.log(json);
    }
    return 0;
  } finally {
    db.close();
  }
}

export function main(argv: string[]): number {
  const [group, cmd, ...rest] = argv;
  if(group==="kb"&&cmd==="migrate-store"){
    try{return runSemanticMigration(rest);}
    catch(error){process.stdout.write(`${JSON.stringify({ok:false,error:{code:"validation_error",message:error instanceof Error?error.message:String(error)}})}\n`);return 2;}
  }
  if (group === "kb" || group === "distill") return runOperation(group,cmd, rest);
  if (group === "hook") {
    return runHook(cmd, rest);
  }
  if (group === "inject" && cmd) {
    const text = rest.shift();
    if (!text) {
      console.error(USAGE);
      return 2;
    }
    let mode: "inject" | "pause" = "inject";
    let context: string | undefined;
    let dbFlag: string | undefined;
    let requestId = `cli-inject-${crypto.randomUUID()}`;
    let json = false;
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (flag === "--mode") {
        const value = rest[++i];
        if (value !== "inject" && value !== "pause") {
          console.error("--mode must be inject or pause");
          return 2;
        }
        mode = value;
      } else if (flag === "--context") context = rest[++i];
      else if (flag === "--db") dbFlag = rest[++i];
      else if (flag === "--request") requestId = rest[++i] ?? requestId;
      else if (flag === "--json") json = true;
      else {
        console.error(`unknown flag: ${flag}`);
        return 2;
      }
    }
    const db = openDb(resolveDbPath(dbFlag));
    try {
      const task = readTask(db, cmd);
      if (!task) {
        console.error(`unknown task: ${cmd}`);
        return 2;
      }
      // The terminal path joins the same idempotent intervention boundary as
      // the App bridge: one request ledger, one receipt truth.
      const intervention: Extract<WorkbenchIntervention, { kind: "inject" | "pause" }> = {
        kind: mode,
        taskId: task.id,
        text,
        ...(context !== undefined ? { contextLocus: context } : {}),
      };
      const result = applyIntervention(
        db,
        task.repoId,
        { requestId, intervention },
        new Date().toISOString(),
      );
      if (json) console.log(JSON.stringify(result));
      else console.log(renderReceipt(projectInjectionInterventionReceipt({
        trigger: "vibehub inject was requested from the terminal.",
        intervention,
        result,
      })));
      return result.outcome === "applied" || result.outcome === "already_applied" ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    } finally {
      db.close();
    }
  }

  const topLevelFlags = (): Flags =>
    parseFlags([cmd, ...rest].filter((value): value is string => value !== undefined));

  if (group === "setup") {
    const wantsJson = [cmd, ...rest].includes("--json");
    if (cmd !== "inspect" && cmd !== "apply" && cmd !== "status") {
      if (wantsJson) {
        process.stdout.write(`${JSON.stringify({
          schemaVersion: 1,
          ok: false,
          error: { code: "validation_error", message: cmd === undefined || cmd === "--json" ? "setup subcommand is required" : `unknown setup subcommand: ${cmd}` },
        })}\n`);
      } else console.error(USAGE);
      return 2;
    }
    let flags: Flags;
    try {
      flags = parseSetupFlags(rest);
    } catch (error) {
      const result = {
        schemaVersion: 1,
        command: cmd,
        ok: false,
        outcome: "blocked",
        errors: [{ code: "validation_error", message: error instanceof Error ? error.message : String(error) }],
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 2;
    }
    const service = new RuntimeService({ dbPath: flags.db });
    let result;
    try {
      const args = [
        flags.repo,
        stateDirFor(flags.db),
        releaseAssetRoot(),
        releaseAssetManifest(),
      ] as const;
      result = cmd === "inspect"
        ? service.inspectProjectActivation(...args)
        : cmd === "apply"
          ? service.applyProjectActivation(...args)
          : service.readProjectActivationStatus(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const blocked = { state: "blocked", evidence: [message] };
      const failed = {
        schemaVersion: 1,
        command: cmd,
        ok: false,
        outcome: "blocked",
        repo: { root: null, toplevel: null, status: "blocked" },
        instructions: [],
        runtime: null,
        init: null,
        activation: { installed: blocked, connected: blocked, activated: blocked },
        errors: [{ code: "runtime_failed", message }],
      };
      process.stdout.write(`${JSON.stringify(failed)}\n`);
      return 1;
    }
    if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else console.log(`${result.command}: ${result.outcome}`);
    return result.ok ? 0 : 1;
  }

  if (group === "init") {
    const flags = topLevelFlags();
    const explicitPluginRoot=process.env["VIBEHUB_PLUGIN_ROOT"];
    if(explicitPluginRoot&&!fs.existsSync(path.resolve(explicitPluginRoot))){
      const result={ok:false,error:{code:"setup_error",message:"explicit plugin root does not exist",details:{pluginRoot:path.resolve(explicitPluginRoot)},nextSafeActions:["Create or install the plugin root, then retry with the same explicit path."]}};
      if(flags.json)process.stdout.write(`${JSON.stringify(result)}\n`);else console.error(result.error.message);
      return 2;
    }
    const result = new RuntimeService({ dbPath: flags.db }).initialize(
      flags.repo,
      stateDirFor(flags.db),
      releaseAssetRoot(),
      releaseAssetManifest(),
    );
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderReceipt(projectInitReceipt({
      trigger: "vibehub init was invoked for this repository.",
      result,
      at: new Date().toISOString(),
    })));
    return result.ok ? 0 : 1;
  }

  if (group === "doctor") {
    const flags = topLevelFlags();
    const result = new RuntimeService({ dbPath: flags.db }).doctor(
      flags.repo,
      stateDirFor(flags.db),
      releaseAssetRoot(),
      releaseAssetManifest(),
    );
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(renderReceipt(projectDoctorReceipt({
      trigger: "vibehub doctor was invoked for this repository.",
      result,
      at: new Date().toISOString(),
    })));
    return result.healthy ? 0 : 1;
  }

  if (group === "snapshot" || group === "inspect") {
    return printSnapshot(topLevelFlags());
  }

  if (group !== "team" || !cmd) {
    console.error(USAGE);
    return 2;
  }
  const flags = parseFlags(rest);

  if (cmd === "sync") {
    const db = openDb(flags.db);
    const result = syncTeamSnapshot(db, flags.repo);
    db.close();
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const gh = result.ghAvailable
        ? `${result.prsMatched} PRs matched`
        : "gh unavailable — PR facts degraded (pure-git only)";
      const fetch =
        result.fetchOk === null
          ? "fetch skipped"
          : result.fetchOk
            ? "fetched"
            : "FETCH FAILED — snapshot is stale";
      console.log(
        `${result.repoRoot}: ${fetch}; ${result.branches} branches ` +
          `(${result.unmergedBranches} unmerged), ` +
          `${result.conflictPairs} conflict pair(s); ${gh}`,
      );
    }
    return 0;
  }

  if (cmd === "snapshot") {
    return printSnapshot(flags);
  }

  console.error(USAGE);
  return 2;
}

function canonicalEntrypoint(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

if (
  process.argv[1] &&
  canonicalEntrypoint(process.argv[1]) === canonicalEntrypoint(fileURLToPath(import.meta.url))
) {
  // Let Node flush stdout/stderr before exiting. Skill wrappers capture the
  // streams asynchronously so an immediate process.exit() could discard a
  // final large JSON envelope.
  process.exitCode = main(process.argv.slice(2));
}
