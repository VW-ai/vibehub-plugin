#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildClaudeMarketplace } from "./build-claude-marketplace.mjs";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const temp = mkdtempSync(join(tmpdir(), "vibehub-thin-plugin-"));
const marketplaceRoot = join(temp, "marketplace");
const runtimeRoot = join(temp, "runtime", `v${identity.version}`);
const home = join(temp, "home");
const repo = join(temp, "repo");
const keep = process.env.VIBEHUB_KEEP_TMP === "1";
const specs = JSON.stringify([
  join(root, "dist", "npm", `vw-ai-vibehub-core-${identity.version}.tgz`),
  join(root, "dist", "npm", `vw-ai-vibehub-cli-${identity.version}.tgz`),
  join(
    root,
    "dist",
    "npm",
    `vw-ai-vibehub-workbench-mcp-${identity.version}.tgz`,
  ),
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function runMcp(command, args, env) {
  const child = spawn(command, args, {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const tools = await new Promise((resolveTools, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`thin MCP startup timed out\n${stderr}`)),
      20_000,
    );
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
              roots: [{ uri: pathToFileURL(repo).href, name: "thin-plugin" }],
            },
          })}\n`,
        );
      }
      if (message.id === 2) {
        if (message.error) {
          finish(() => reject(new Error(line)));
        } else {
          finish(() => resolveTools(message.result?.tools));
        }
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== "SIGTERM") {
        finish(() =>
          reject(
            new Error(
              `thin MCP exited before tools/list (${code ?? signal})\n${stderr}`,
            ),
          ),
        );
      }
    });
    const send = (message) =>
      child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: false } },
        clientInfo: { name: "thin-plugin", version: identity.version },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await exited;
  return tools;
}

try {
  const marketplace = buildClaudeMarketplace({ outputRoot: marketplaceRoot });
  const artifact = marketplace.pluginRoot;
  const launcher = join(artifact, "runtime", "vibehub-runtime.mjs");
  if (!existsSync(launcher)) throw new Error("thin runtime launcher is absent");
  for (const forbidden of ["node_modules", "packages"]) {
    if (existsSync(join(artifact, forbidden))) {
      throw new Error(`thin plugin must not contain ${forbidden}`);
    }
  }

  const claudeConfig = join(home, ".claude");
  mkdirSync(claudeConfig, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const hostEnv = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeConfig,
    NPM_CONFIG_CACHE: join(temp, "npm-cache"),
    VIBEHUB_RUNTIME_DIR: runtimeRoot,
    VIBEHUB_RUNTIME_PACKAGE_SPECS: specs,
  };
  run("claude", ["plugin", "validate", "--strict", marketplaceRoot], {
    env: hostEnv,
  });
  run(
    "claude",
    ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"],
    { env: hostEnv },
  );
  run(
    "claude",
    ["plugin", "install", "vibehub@vibehub-local", "--scope", "user"],
    { env: hostEnv },
  );
  const installed = JSON.parse(
    run("claude", ["plugin", "list", "--json"], { env: hostEnv }),
  ).find((entry) => entry.id === "vibehub@vibehub-local");
  if (!installed?.enabled || !existsSync(installed.installPath)) {
    throw new Error("Claude did not install the thin VibeHub plugin");
  }
  const installedRoot = realpathSync(installed.installPath);
  if (
    existsSync(join(installedRoot, "node_modules")) ||
    existsSync(join(installedRoot, "packages"))
  ) {
    throw new Error("Claude installation materialized a legacy runtime");
  }

  run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  run("git", ["config", "user.email", "thin-plugin@vibehub.local"], {
    cwd: repo,
  });
  run("git", ["config", "user.name", "VibeHub Thin Plugin"], { cwd: repo });
  run("git", ["commit", "-q", "--allow-empty", "-m", "seed"], { cwd: repo });
  const installedHooks = readJson(join(installedRoot, "hooks", "hooks.json"));
  const session = installedHooks.hooks.SessionStart[0].hooks[0];
  const hookEnv = {
    ...hostEnv,
    CLAUDE_PLUGIN_ROOT: installedRoot,
  };
  const hookInput = JSON.stringify({
    session_id: "thin-plugin-session",
    cwd: repo,
    hook_event_name: "SessionStart",
  });
  const hook = JSON.parse(
    run(
      session.command,
      session.args.map((arg) =>
        arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
      ),
      { cwd: repo, env: hookEnv, input: hookInput },
    ),
  );
  if (!hook.hookSpecificOutput?.additionalContext?.includes("persistent context layer")) {
    throw new Error("thin SessionStart hook did not return context-first VibeHub guidance");
  }

  const cliManifest = join(
    runtimeRoot,
    "node_modules",
    "@vw-ai",
    "vibehub-cli",
    "package.json",
  );
  const firstRuntimeMtime = statSync(cliManifest).mtimeMs;
  const secondHook = JSON.parse(
    run(
      session.command,
      session.args.map((arg) =>
        arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
      ),
      { cwd: repo, env: hookEnv, input: hookInput },
    ),
  );
  if (
    !secondHook.hookSpecificOutput ||
    statSync(cliManifest).mtimeMs !== firstRuntimeMtime
  ) {
    throw new Error("thin runtime cache was not reused");
  }

  const mcp = readJson(join(installedRoot, ".mcp.json")).mcpServers.vibehub;
  const tools = await runMcp(
    mcp.command,
    mcp.args.map((arg) =>
      arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
    ),
    hookEnv,
  );
  if (!Array.isArray(tools) || !tools.some((tool) => tool.name === "kb_retrieve")) {
    throw new Error("thin MCP did not expose VibeHub tools");
  }

  const runtimePackages = [
    "@vw-ai/vibehub-core",
    "@vw-ai/vibehub-cli",
    "@vw-ai/vibehub-workbench-mcp",
  ];
  for (const name of runtimePackages) {
    const [scope, packageName] = name.split("/");
    const manifest = readJson(
      join(runtimeRoot, "node_modules", scope, packageName, "package.json"),
    );
    if (manifest.version !== identity.version) {
      throw new Error(`${name} runtime version drifted`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: identity.version,
      artifact: "thin",
      runtime: "npm",
      cache: "reused",
      claude: "installed",
      mcp: "ready",
    })}\n`,
  );
} finally {
  if (keep) {
    process.stderr.write(`kept thin plugin verification at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
