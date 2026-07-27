#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const positional = process.argv.slice(2).filter((arg) => arg !== "--");
if (!positional[0] || positional.length !== 1) {
  throw new Error("usage: verify-release-hosts.mjs <marketplace-directory>");
}

const marketplaceRoot = resolve(positional[0]);
if (!existsSync(marketplaceRoot)) {
  throw new Error(`marketplace does not exist: ${marketplaceRoot}`);
}

const temp = mkdtempSync(join(tmpdir(), "vibehub-release-hosts-"));

function run(command, args, env, cwd = temp, input) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

try {
  const claudeHome = join(temp, "claude-home");
  const claudeConfig = join(claudeHome, ".claude");
  mkdirSync(claudeConfig, { recursive: true });
  const claudeEnv = {
    ...process.env,
    HOME: claudeHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
  };
  run("claude", ["plugin", "validate", "--strict", marketplaceRoot], claudeEnv);
  run(
    "claude",
    ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"],
    claudeEnv,
  );
  run(
    "claude",
    ["plugin", "install", "vibehub@vibehub", "--scope", "user"],
    claudeEnv,
  );
  const claudePlugins = JSON.parse(
    run("claude", ["plugin", "list", "--json"], claudeEnv),
  );
  const claudePlugin = claudePlugins.find(
    (plugin) => plugin.id === "vibehub@vibehub",
  );
  if (
    !claudePlugin?.enabled ||
    typeof claudePlugin.installPath !== "string" ||
    !existsSync(claudePlugin.installPath)
  ) {
    throw new Error("Claude did not install vibehub@vibehub from the release catalog");
  }
  const installedRoot = realpathSync(claudePlugin.installPath);
  const hooks = JSON.parse(
    readFileSync(join(installedRoot, "hooks", "hooks.json"), "utf8"),
  );
  const session = hooks.hooks.SessionStart[0].hooks[0];
  const repo = join(temp, "repo");
  const runtimeRoot = join(temp, "public-npm-runtime");
  mkdirSync(repo, { recursive: true });
  run("git", ["init", "-q", "-b", "main"], claudeEnv, repo);
  run(
    "git",
    ["-c", "user.email=release@vibehub.local", "-c", "user.name=VibeHub Release", "commit", "-q", "--allow-empty", "-m", "seed"],
    claudeEnv,
    repo,
  );
  const runtimeEnv = {
    ...claudeEnv,
    CLAUDE_PLUGIN_ROOT: installedRoot,
    NPM_CONFIG_CACHE: join(temp, "npm-cache"),
    VIBEHUB_RUNTIME_DIR: runtimeRoot,
  };
  const hookOutput = JSON.parse(
    run(
      session.command,
      session.args.map((arg) =>
        arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installedRoot),
      ),
      runtimeEnv,
      repo,
      JSON.stringify({
        session_id: "public-release-verification",
        cwd: repo,
        hook_event_name: "SessionStart",
      }),
    ),
  );
  if (!hookOutput.hookSpecificOutput?.additionalContext?.includes("register_scope")) {
    throw new Error("installed Claude plugin did not start the public npm runtime");
  }

  const codexHome = join(temp, "codex-home");
  const codexUserHome = join(temp, "codex-user-home");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(codexUserHome, { recursive: true });
  const codexEnv = {
    ...process.env,
    HOME: codexUserHome,
    CODEX_HOME: codexHome,
  };
  JSON.parse(
    run(
      process.env.CODEX_BIN || "codex",
      ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
      codexEnv,
    ),
  );
  JSON.parse(
    run(
      process.env.CODEX_BIN || "codex",
      ["plugin", "add", "vibehub@vibehub", "--json"],
      codexEnv,
    ),
  );
  const codexPlugins = JSON.parse(
    run(
      process.env.CODEX_BIN || "codex",
      ["plugin", "list", "--available", "--json"],
      codexEnv,
    ),
  );
  const codexSerialized = JSON.stringify(codexPlugins);
  if (!codexSerialized.includes("vibehub")) {
    throw new Error("Codex did not expose vibehub@vibehub from the release catalog");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      marketplaceRoot,
      claude: "installed",
      runtime: "public npm",
      codex: "installed",
    })}\n`,
  );
} finally {
  if (process.env.VIBEHUB_KEEP_TMP === "1") {
    process.stderr.write(`kept release host verification at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
