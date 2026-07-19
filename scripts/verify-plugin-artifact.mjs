#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPluginArtifact } from "./build-plugin-artifact.mjs";

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
  const allowedStatuses = options.allowedStatuses ?? [0];
  if (!allowedStatuses.includes(result.status)) {
    const details = options.capture ? `\n${stdout}\n${stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${details}`);
  }
  return stdout;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid packaged JSON at ${path}: ${error.message}`);
  }
}

function expandPluginRoot(value, pluginRoot) {
  if (typeof value !== "string") throw new Error("configured command values must be strings");
  return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
}

function readConfiguredEntrypoints(pluginRoot) {
  const manifest = readJson(join(pluginRoot, ".claude-plugin/plugin.json"));
  for (const field of ["name", "displayName", "version", "description", "license"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      throw new Error(`plugin manifest requires non-empty ${field}`);
    }
  }
  if (!manifest.author || typeof manifest.author.name !== "string") {
    throw new Error("plugin manifest requires author.name");
  }

  const hooksConfig = readJson(join(pluginRoot, "hooks/hooks.json"));
  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== "object" || Array.isArray(hooksConfig.hooks)) {
    throw new Error("hooks/hooks.json requires a hooks object");
  }
  const hooks = [];
  for (const [eventName, groups] of Object.entries(hooksConfig.hooks)) {
    if (!Array.isArray(groups) || groups.length === 0) {
      throw new Error(`hook event ${eventName} requires at least one group`);
    }
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks) || group.hooks.length === 0) {
        throw new Error(`hook event ${eventName} requires command hooks`);
      }
      for (const hook of group.hooks) {
        if (hook?.type !== "command" || typeof hook.command !== "string" || !Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === "string")) {
          throw new Error(`hook event ${eventName} has an invalid command shape`);
        }
        hooks.push({
          eventName,
          command: expandPluginRoot(hook.command, pluginRoot),
          args: hook.args.map((arg) => expandPluginRoot(arg, pluginRoot)),
        });
      }
    }
  }
  if (!hooks.some((hook) => hook.eventName === "SessionStart")) {
    throw new Error("hooks/hooks.json must configure SessionStart");
  }

  const mcpConfig = readJson(join(pluginRoot, ".mcp.json"));
  if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object" || Array.isArray(mcpConfig.mcpServers)) {
    throw new Error(".mcp.json requires an mcpServers object");
  }
  const mcpEntries = Object.entries(mcpConfig.mcpServers);
  if (mcpEntries.length === 0) throw new Error(".mcp.json requires at least one server");
  const mcpServers = mcpEntries.map(([name, server]) => {
    if (server?.type !== "stdio" || typeof server.command !== "string" || !Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) {
      throw new Error(`MCP server ${name} has an invalid stdio command shape`);
    }
    return {
      name,
      command: expandPluginRoot(server.command, pluginRoot),
      args: server.args.map((arg) => expandPluginRoot(arg, pluginRoot)),
    };
  });
  return { hooks, mcpServers };
}

function assertCodexPackage(pluginRoot) {
  const manifest = readJson(join(pluginRoot, ".codex-plugin/plugin.json"));
  if (
    manifest.name !== "vibehub" ||
    manifest.skills !== "./skills/" ||
    manifest.mcpServers !== "./codex/mcp.json" ||
    manifest.hooks !== "./codex/hooks.json"
  ) {
    throw new Error("Codex manifest does not bind the shared skills and thin host configs");
  }
  const mcp = readJson(join(pluginRoot, "codex/mcp.json"));
  const server = mcp.mcpServers?.vibehub;
  const expectedMcpArg = "./packages/mcp/dist/stdio.js";
  if (
    server?.command !== "node" ||
    server.cwd !== "." ||
    JSON.stringify(server.args) !== JSON.stringify([expectedMcpArg]) ||
    !existsSync(join(pluginRoot, expectedMcpArg))
  ) {
    throw new Error("Codex MCP config must resolve its installed relative entrypoint");
  }
  const hooks = readJson(join(pluginRoot, "codex/hooks.json")).hooks ?? {};
  const eventNames = Object.keys(hooks).sort();
  if (
    JSON.stringify(eventNames) !==
    JSON.stringify(["PostToolUse", "SessionStart", "UserPromptSubmit"].sort())
  ) {
    throw new Error(`unexpected Codex hook boundary: ${eventNames.join(", ")}`);
  }
  for (const forbidden of ["Stop", "SessionEnd"]) {
    if (hooks[forbidden]) throw new Error(`Codex package must not claim ${forbidden} parity`);
  }
  for (const [eventName, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (
          hook?.type !== "command" ||
          typeof hook.command !== "string" ||
          !hook.command.includes(` hook ${eventName} --host codex`) ||
          "args" in hook
        ) {
          throw new Error(`Codex ${eventName} must use one host-attributed command string`);
        }
      }
    }
  }
}

function assertConfiguredPaths(entries, pluginRoot) {
  for (const entry of entries) {
    for (const value of [entry.command, ...entry.args]) {
      if (value.startsWith(`${pluginRoot}/`) && !existsSync(value)) {
        throw new Error(`configured path does not exist: ${value}`);
      }
    }
  }
}

async function assertConfiguredPathFailure(configPath, mutate, invoke) {
  const original = readFileSync(configPath, "utf8");
  const config = JSON.parse(original);
  mutate(config);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  let failed = false;
  try {
    await invoke();
  } catch (error) {
    failed = true;
    if (!String(error.message).includes("configured path does not exist")) throw error;
  } finally {
    writeFileSync(configPath, original);
  }
  if (!failed) throw new Error(`corrupt configured path unexpectedly passed: ${configPath}`);
}

async function runMcpClient(command, args, { cwd, env, rootPath }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`packaged MCP smoke timed out\n${stderr}`));
    }, 10_000);
    const finish = (callback) => {
      clearTimeout(timeout);
      lines.close();
      callback();
    };

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method === "roots/list" && message.id !== undefined) {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              roots: [{ uri: pathToFileURL(rootPath).href, name: "artifact-smoke" }],
            },
          })}\n`,
        );
        return;
      }
      if (message.id === 2) {
        if (message.error) {
          finish(() => reject(new Error(`packaged MCP tools/list failed: ${line}`)));
        } else {
          finish(() => resolve(message.result?.tools));
        }
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== "SIGTERM") {
        finish(() =>
          reject(
            new Error(
              `packaged MCP exited before tools/list (${code ?? signal})\n${stderr}`,
            ),
          ),
        );
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: "artifact-smoke", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
  child.kill("SIGTERM");
  return result;
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

try {
  const deployArgs = process.env.VIBEHUB_OFFLINE === "1" ? ["--offline"] : [];
  buildPluginArtifact({
    sourceRoot: root,
    artifactRoot: artifact,
    offline: deployArgs.length > 0,
  });
  assertCodexPackage(artifact);

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
    CLAUDE_PLUGIN_ROOT: artifact,
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
  const invokeSetupJson = (args) =>
    JSON.parse(
      run(installedBin, args, {
        cwd: repo,
        env: cleanEnv,
        capture: true,
        allowedStatuses: [0, 1],
      }),
    );

  const setupInspect = invokeSetupJson(["setup", "inspect", "--repo", repo, "--json"]);
  if (
    !setupInspect.ok ||
    setupInspect.command !== "inspect" ||
    setupInspect.outcome !== "changes_required" ||
    !setupInspect.instructions.every((item) => item.changed)
  ) {
    throw new Error("packaged setup inspect did not report the clean checkout plan");
  }
  const setupApply = invokeSetupJson(["setup", "apply", "--repo", repo, "--json"]);
  if (
    !setupApply.ok ||
    setupApply.command !== "apply" ||
    setupApply.outcome !== "applied" ||
    setupApply.activation.installed.state !== "proven"
  ) {
    throw new Error("packaged setup apply did not install the clean checkout");
  }
  const secondSetupApply = invokeSetupJson(["setup", "apply", "--repo", repo, "--json"]);
  if (
    !secondSetupApply.ok ||
    secondSetupApply.outcome !== "unchanged" ||
    secondSetupApply.instructions.some((item) => item.changed)
  ) {
    throw new Error("second packaged setup apply was not idempotent");
  }
  const secondSetupInspect = invokeSetupJson(["setup", "inspect", "--repo", repo, "--json"]);
  if (
    !secondSetupInspect.ok ||
    secondSetupInspect.outcome !== "ready" ||
    secondSetupInspect.instructions.some((item) => item.status !== "current" || item.changed)
  ) {
    throw new Error("second packaged setup inspect did not report a current checkout");
  }
  const setupStatus = invokeSetupJson(["setup", "status", "--repo", repo, "--json"]);
  if (
    setupStatus.ok ||
    setupStatus.outcome !== "waiting" ||
    setupStatus.activation.installed.state !== "proven" ||
    setupStatus.activation.connected.state !== "not_proven" ||
    setupStatus.activation.activated.state !== "not_proven"
  ) {
    throw new Error("packaged setup status did not wait honestly before a host handshake");
  }

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

  // Codex onboarding path: the deployed managed tree must carry the exact
  // bounded hook contract. Registry completeness and per-skill openai.yaml
  // metadata are already guaranteed by the packaged validator run above.
  const codexReference = readFileSync(
    join(casePluginRoot, "skills/vibehub-setup/references/codex.md"),
    "utf8",
  );
  if (
    !codexReference.includes("Connected requires a real, trusted Codex `SessionStart`") ||
    !codexReference.includes("Intentionally absent from the Codex hook package")
  ) {
    throw new Error("packaged Codex onboarding reference lost its evidence boundary");
  }

  const hookInput = JSON.stringify({
    session_id: "artifact-session",
    cwd: repo,
    hook_event_name: "SessionStart",
  });
  const runConfiguredHook = () => {
    const configured = readConfiguredEntrypoints(artifact);
    assertConfiguredPaths(configured.hooks, artifact);
    const hookCommand = configured.hooks.find((hook) => hook.eventName === "SessionStart");
    return run(hookCommand.command, hookCommand.args, {
      cwd: repo,
      env: cleanEnv,
      capture: true,
      input: hookInput,
    });
  };
  const hookOutput = runConfiguredHook();
  const hook = JSON.parse(hookOutput);
  if (!hook.hookSpecificOutput?.additionalContext?.includes("register_scope")) {
    throw new Error("packaged hook did not emit the VibeHub session protocol");
  }

  const runConfiguredMcp = async () => {
    const configured = readConfiguredEntrypoints(artifact);
    assertConfiguredPaths(configured.mcpServers, artifact);
    const mcpCommand = configured.mcpServers.find((server) => server.name === "vibehub") ?? configured.mcpServers[0];
    return runMcpClient(mcpCommand.command, mcpCommand.args, {
      cwd: repo,
      env: cleanEnv,
      rootPath: repo,
    });
  };
  const toolList = await runConfiguredMcp();
  if (!Array.isArray(toolList) || !toolList.some((tool) => tool.name === "kb_retrieve")) {
    throw new Error("packaged MCP did not initialize and list deterministic capabilities");
  }

  await assertConfiguredPathFailure(
    join(artifact, "hooks/hooks.json"),
    (config) => {
      const command = config.hooks.SessionStart[0].hooks[0];
      command.args[0] = "${CLAUDE_PLUGIN_ROOT}/packages/cli/dist/missing.js";
    },
    runConfiguredHook,
  );
  await assertConfiguredPathFailure(
    join(artifact, ".mcp.json"),
    (config) => {
      const server = config.mcpServers.vibehub ?? Object.values(config.mcpServers)[0];
      server.args[0] = "${CLAUDE_PLUGIN_ROOT}/packages/mcp/dist/missing.js";
    },
    runConfiguredMcp,
  );

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
    "plugin artifact: self-contained setup skill/CLI/hooks/MCP with Codex onboarding path; idempotent setup/init, honest pre-handshake status, doctor, sync, snapshot, and clean-HOME native SQLite passed",
  );
} finally {
  if (keep) console.log(`kept plugin artifact at ${artifact}`);
  else rmSync(temp, { recursive: true, force: true });
}
