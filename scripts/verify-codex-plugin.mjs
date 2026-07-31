#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildCodexMarketplace } from "./build-codex-marketplace.mjs";
import { verifyCodexHostStartsMcp } from "./lib/verify-codex-host.mjs";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const temp = mkdtempSync(join(tmpdir(), "vibehub-codex-plugin-"));
const keep = process.env.VIBEHUB_KEEP_TMP === "1";
const runtimeRoot = join(
  temp,
  "home",
  ".vibehub",
  "runtime",
  "npm",
  `v${identity.version}`,
);
const runtimeSpecs = JSON.stringify([
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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON at ${path}: ${error.message}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? temp,
    env: options.env ?? process.env,
    encoding: "utf8",
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function assertManifestAndConfigs(pluginRoot) {
  const manifest = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));
  if (
    manifest.name !== "vibehub" ||
    manifest.skills !== "./skills/" ||
    manifest.mcpServers !== "./codex/mcp.json" ||
    manifest.hooks !== "./codex/hooks.json"
  ) {
    throw new Error("Codex manifest does not point at the shared skills and host configs");
  }
  const defaultPrompts = manifest.interface?.defaultPrompt;
  if (
    !Array.isArray(defaultPrompts) ||
    defaultPrompts.length < 1 ||
    defaultPrompts.length > 3 ||
    defaultPrompts.some(
      (prompt) => typeof prompt !== "string" || prompt.trim().length === 0,
    )
  ) {
    throw new Error(
      "Codex defaultPrompt must contain one to three non-empty prompts",
    );
  }

  const mcp = readJson(join(pluginRoot, "codex", "mcp.json"));
  const server = mcp.mcpServers?.vibehub;
  if (
    server?.command !== "node" ||
    server.cwd !== "." ||
    JSON.stringify(server.args) !==
      JSON.stringify(["./runtime/vibehub-runtime.mjs", "mcp"])
  ) {
    throw new Error("Codex MCP must use the installed relative entrypoint and plugin cwd");
  }
  const entrypoint = join(pluginRoot, server.args[0]);
  if (!existsSync(entrypoint)) {
    throw new Error(`Codex MCP entrypoint is absent: ${server.args[0]}`);
  }

  const hooks = readJson(join(pluginRoot, "codex", "hooks.json"));
  const eventNames = Object.keys(hooks.hooks ?? {}).sort();
  const expectedEvents = ["PostToolUse", "SessionStart", "UserPromptSubmit"].sort();
  if (JSON.stringify(eventNames) !== JSON.stringify(expectedEvents)) {
    throw new Error(
      `Codex hook boundary drifted: expected ${expectedEvents.join(", ")}, got ${eventNames.join(", ")}`,
    );
  }
  for (const forbidden of ["Stop", "SessionEnd"]) {
    if (hooks.hooks?.[forbidden]) {
      throw new Error(`Codex hooks must not claim unsupported ${forbidden} parity`);
    }
  }
  for (const [eventName, groups] of Object.entries(hooks.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks ?? []) {
        if (
          handler.type !== "command" ||
          typeof handler.command !== "string" ||
          !handler.command.includes(` hook ${eventName} --host codex`)
        ) {
          throw new Error(`Codex ${eventName} hook lost its host-attributed command`);
        }
        if ("args" in handler) {
          throw new Error(`Codex ${eventName} hook must use a command string, not Claude args`);
        }
      }
    }
  }
}

try {
  const marketplace = buildCodexMarketplace({
    outputRoot: join(temp, "marketplace"),
  });
  assertManifestAndConfigs(marketplace.pluginRoot);

  const codexHome = join(temp, "codex-home");
  const home = join(temp, "home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: codexHome,
    NPM_CONFIG_CACHE: join(temp, "npm-cache"),
    VIBEHUB_RUNTIME_DIR: runtimeRoot,
    VIBEHUB_RUNTIME_PACKAGE_SPECS: runtimeSpecs,
  };
  const codexBin = process.env.CODEX_BIN || "codex";
  JSON.parse(
    run(
      codexBin,
      ["plugin", "marketplace", "add", marketplace.outputRoot, "--json"],
      { env },
    ),
  );
  JSON.parse(
    run(
      codexBin,
      ["plugin", "add", `vibehub@${marketplace.marketplaceName}`, "--json"],
      { env },
    ),
  );
  const listed = JSON.parse(
    run(codexBin, ["plugin", "list", "--available", "--json"], { env }),
  );
  const serializedList = JSON.stringify(listed);
  if (!serializedList.includes("vibehub") || !serializedList.includes(marketplace.marketplaceName)) {
    throw new Error("Codex did not list the locally ingested VibeHub plugin");
  }

  const installedVersion = readJson(
    join(marketplace.pluginRoot, ".codex-plugin", "plugin.json"),
  ).version;
  const installedRoot = join(
    codexHome,
    "plugins",
    "cache",
    marketplace.marketplaceName,
    "vibehub",
    installedVersion,
  );
  if (!existsSync(installedRoot)) {
    throw new Error(`Codex did not materialize its installed plugin copy: ${installedRoot}`);
  }
  assertManifestAndConfigs(realpathSync(installedRoot));

  const repo = join(temp, "repo");
  mkdirSync(repo);
  run("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  run("git", ["config", "user.email", "codex-plugin@vibehub.local"], { cwd: repo, env });
  run("git", ["config", "user.name", "VibeHub Codex Plugin"], { cwd: repo, env });
  writeFileSync(join(repo, "README.md"), "codex plugin smoke\n");
  run("git", ["add", "README.md"], { cwd: repo, env });
  run("git", ["commit", "-q", "-m", "seed"], { cwd: repo, env });

  const installedHooks = readJson(join(installedRoot, "codex", "hooks.json"));
  const sessionCommand = installedHooks.hooks.SessionStart[0].hooks[0].command;
  const hookOutput = run("/bin/sh", ["-c", sessionCommand], {
    cwd: repo,
    env: {
      ...env,
      CLAUDE_PLUGIN_ROOT: installedRoot,
      PLUGIN_ROOT: installedRoot,
    },
    input: JSON.stringify({
      session_id: "codex-artifact-session",
      transcript_path: null,
      cwd: repo,
      hook_event_name: "SessionStart",
      model: "gpt-5",
      permission_mode: "default",
      source: "startup",
    }),
  });
  const hookReceipt = JSON.parse(hookOutput);
  if (!hookReceipt.hookSpecificOutput?.additionalContext?.includes("register_scope")) {
    throw new Error("installed Codex SessionStart hook did not emit the shared protocol");
  }

  await verifyCodexHostStartsMcp(codexBin, env, repo);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      result: "Codex marketplace ingestion, installed hook, and real app-server MCP startup accepted the shared VibeHub artifact",
      hooks: ["SessionStart", "UserPromptSubmit", "PostToolUse"],
      intentionallyAbsent: ["Stop", "SessionEnd"],
    })}\n`,
  );
} finally {
  if (keep) process.stderr.write(`kept Codex plugin verification at ${temp}\n`);
  else rmSync(temp, { recursive: true, force: true });
}
