#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "vibehub-plugin-artifact-"));
const artifact = join(temp, "plugin");
const keep = process.env.VIBEHUB_KEEP_TMP === "1";
let captureSeq = 0;

function run(command, args, options = {}) {
  const captureBase = options.capture ? join(temp, `.capture-${captureSeq++}`) : null;
  const stdoutFd = captureBase ? openSync(`${captureBase}.out`, "w") : null;
  const stderrFd = captureBase ? openSync(`${captureBase}.err`, "w") : null;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    // Node 23 truncates synchronous pipe capture at 8 KiB on this macOS
    // runtime. Capture to regular files so recursive skill manifests are read
    // in full and the standalone gate never parses a truncated success JSON.
    stdio: options.capture ? ["pipe", stdoutFd, stderrFd] : "inherit",
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
  if (stdoutFd !== null) closeSync(stdoutFd);
  if (stderrFd !== null) closeSync(stderrFd);
  const stdout = captureBase ? readFileSync(`${captureBase}.out`, "utf8") : "";
  const stderr = captureBase ? readFileSync(`${captureBase}.err`, "utf8") : "";
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = options.capture ? `\n${stdout}\n${stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${details}`);
  }
  return stdout;
}

function copy(relativePath) {
  cpSync(join(root, relativePath), join(artifact, relativePath), { recursive: true });
}

function createArtifactCase(name, deployArgs) {
  const caseRoot = join(temp, "cases", name);
  const casePluginRoot = join(caseRoot, "plugin");
  const home = join(caseRoot, "home");
  const repo = join(caseRoot, "repo");
  const origin = join(caseRoot, "origin.git");
  mkdirSync(caseRoot, { recursive: true });
  mkdirSync(casePluginRoot, { recursive: true });
  writeFileSync(join(caseRoot, "package.json"), `${JSON.stringify({ private: true })}\n`);
  run("pnpm", [
    ...deployArgs,
    "--dir",
    caseRoot,
    "link",
    join(artifact, "packages/cli"),
  ]);
  const installedBin = join(caseRoot, "node_modules/.bin/vibehub");
  if (!existsSync(installedBin)) {
    throw new Error(`package manager did not create installed vibehub bin: ${installedBin}`);
  }
  return { caseRoot, casePluginRoot, home, repo, origin, installedBin };
}

function sanitizeAndAssertSelfContained(packageRoot) {
  const modules = join(packageRoot, "node_modules");
  if (!existsSync(modules)) throw new Error(`deployed package has no node_modules: ${packageRoot}`);
  const artifactRoot = realpathSync(artifact);
  const pending = [modules];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        let resolved;
        try {
          resolved = realpathSync(child);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
          resolved = resolve(dirname(child), readlinkSync(child));
          // macOS exposes /var as /private/var. Keep lexical checks aligned
          // even for a deliberately broken/self-reference pnpm metadata link.
          if (resolved.startsWith("/var/")) resolved = `/private${resolved}`;
        }
        if (relative(artifactRoot, resolved).startsWith("..")) {
          if (child.includes("/node_modules/.pnpm/node_modules/@vibehub/")) {
            unlinkSync(child);
            continue;
          }
          throw new Error(`artifact dependency escapes package root: ${child} -> ${resolved}`);
        }
      } else if (stat.isDirectory()) {
        pending.push(child);
      }
    }
  }
}

try {
  mkdirSync(artifact, { recursive: true });
  for (const path of [".claude-plugin", ".mcp.json", "hooks", "skills", "LICENSE", "README.md"]) {
    copy(path);
  }

  const deployArgs = process.env.VIBEHUB_OFFLINE === "1" ? ["--offline"] : [];
  run("pnpm", [
    ...deployArgs,
    "--filter",
    "@vibehub/cli",
    "--prod",
    "deploy",
    "--legacy",
    join(artifact, "packages/cli"),
  ]);
  run("pnpm", [
    ...deployArgs,
    "--filter",
    "@vibehub/workbench-mcp",
    "--prod",
    "deploy",
    "--legacy",
    join(artifact, "packages/mcp"),
  ]);

  // Legacy deploy leaves a pnpm metadata backlink for the package being
  // deployed. It is not used at runtime, but retaining an absolute source
  // workspace link would make the artifact fail the standalone guarantee.
  for (const backlink of [
    join(artifact, "packages/cli/node_modules/.pnpm/node_modules/@vibehub/cli"),
    join(
      artifact,
      "packages/mcp/node_modules/.pnpm/node_modules/@vibehub/workbench-mcp",
    ),
  ]) {
    try {
      unlinkSync(backlink);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  sanitizeAndAssertSelfContained(join(artifact, "packages/cli"));
  sanitizeAndAssertSelfContained(join(artifact, "packages/mcp"));

  const { casePluginRoot, home, repo, origin, installedBin } = createArtifactCase(
    "default",
    deployArgs,
  );
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  run("git", ["config", "user.email", "artifact-smoke@vibehub.local"], { cwd: repo });
  run("git", ["config", "user.name", "VibeHub Artifact Smoke"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# artifact smoke\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-q", "-m", "initial"], { cwd: repo });
  run("git", ["init", "-q", "--bare", origin], { cwd: temp });
  run("git", ["remote", "add", "origin", origin], { cwd: repo });
  run("git", ["push", "-q", "-u", "origin", "main"], { cwd: repo });

  const cleanEnv = {
    HOME: home,
    PATH: `${dirname(installedBin)}:${process.env.PATH ?? ""}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    NODE_PATH: "",
    VIBEHUB_REPO: repo,
    VIBEHUB_PLUGIN_ROOT: casePluginRoot,
  };
  const invokeJson = (args) =>
    JSON.parse(
      run(installedBin, args, {
        cwd: repo,
        env: cleanEnv,
        capture: true,
      }),
    );

  const firstInit = invokeJson(["init", "--repo", repo, "--json"]);
  if (!firstInit.ok || firstInit.conflicts.length !== 0) {
    throw new Error("first packaged init did not initialize cleanly");
  }
  const secondInit = invokeJson(["init", "--repo", repo, "--json"]);
  if (
    !secondInit.ok ||
    secondInit.managedAssets.some((asset) => asset.status !== "healthy")
  ) {
    throw new Error("second packaged init was not idempotent");
  }
  const doctor = invokeJson(["doctor", "--repo", repo, "--json"]);
  if (
    !doctor.healthy ||
    doctor.db.status !== "healthy" ||
    doctor.nativeDependency.status !== "healthy" ||
    doctor.managedAssets.status !== "healthy"
  ) {
    throw new Error("packaged doctor did not report a healthy runtime");
  }

  // Exercise the case-local managed skills against the package-manager-created
  // installed bin. A fresh case can reuse createArtifactCase without inheriting
  // managed files or HOME state from this one.
  const skillEnv={...cleanEnv,VIBEHUB_BIN:installedBin};
  const skillStatus=JSON.parse(run("node",[join(casePluginRoot,"skills/scripts/vh-kb.mjs"),"status","--repo",repo,"--actor","artifact-skill","--request","artifact-skill-status"],{cwd:repo,env:skillEnv,capture:true,input:"{}"}));
  if(!skillStatus.ok||skillStatus.meta?.operation!=="kb.status")throw new Error("packaged skill wrapper did not dispatch through packaged CLI");
  const inventory=JSON.parse(run("node",[join(casePluginRoot,"skills/scripts/inventory.mjs"),"--repo",repo,"--run-id","artifact-inventory"],{cwd:repo,env:skillEnv,capture:true}));
  if(Object.keys(inventory).join(",")!=="runId,rows"||inventory.runId!=="artifact-inventory"||!inventory.rows.some((row)=>row.path==="README.md"&&row.classification==="included"))throw new Error("packaged inventory helper did not produce exact deterministic operation input");
  const skillPackage=JSON.parse(run("node",[join(casePluginRoot,"skills/scripts/validate-artifact.mjs"),"--package",join(casePluginRoot,"skills")],{cwd:repo,env:skillEnv,capture:true}));
  if(!skillPackage.valid)throw new Error("packaged skill resource graph is invalid");

  const hookOutput = run(installedBin, ["hook", "SessionStart"], {
    cwd: repo,
    env: cleanEnv,
    capture: true,
    input: JSON.stringify({
      session_id: "artifact-session",
      cwd: repo,
      hook_event_name: "SessionStart",
    }),
  });
  const hook = JSON.parse(hookOutput);
  if (!hook.hookSpecificOutput?.additionalContext?.includes("register_scope")) {
    throw new Error("packaged hook did not emit the VibeHub session protocol");
  }

  const mcpInput = [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "artifact-smoke", version: "1.0.0" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    "",
  ].join("\n");
  const mcpOutput = run(
    "node",
    [realpathSync(join(artifact, "packages/mcp/dist/stdio.js"))],
    { cwd: repo, env: cleanEnv, capture: true, input: mcpInput, timeout: 10_000 },
  );
  const mcpMessages = mcpOutput.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const toolList = mcpMessages.find((message) => message.id === 2)?.result?.tools;
  if (!Array.isArray(toolList) || !toolList.some((tool) => tool.name === "kb_retrieve")) {
    throw new Error("packaged MCP did not initialize and list deterministic capabilities");
  }

  const syncOutput = run(installedBin, ["team", "sync", "--repo", repo, "--json"], {
    cwd: repo,
    env: cleanEnv,
    capture: true,
  });
  const sync = JSON.parse(syncOutput);
  if (realpathSync(sync.repoRoot) !== realpathSync(repo)) {
    throw new Error(`artifact CLI resolved wrong repo: ${sync.repoRoot}`);
  }

  const snapshotOutput = run(installedBin, ["snapshot", "--repo", repo], {
    cwd: repo,
    env: cleanEnv,
    capture: true,
  });
  JSON.parse(snapshotOutput);

  const dbPath = join(home, ".vibehub", "workbench.db");
  if (!existsSync(dbPath)) throw new Error(`native SQLite runtime did not create ${dbPath}`);
  if (homedir() === home) throw new Error("smoke HOME unexpectedly equals the developer HOME");

  console.log(
    "plugin artifact: self-contained CLI/hooks/MCP; idempotent init, doctor, sync, snapshot, and clean-HOME native SQLite passed",
  );
} finally {
  if (keep) console.log(`kept plugin artifact at ${artifact}`);
  else rmSync(temp, { recursive: true, force: true });
}
