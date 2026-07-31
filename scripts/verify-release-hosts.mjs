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
import { verifyCodexHostStartsMcp } from "./lib/verify-codex-host.mjs";

const positional = process.argv.slice(2).filter((arg) => arg !== "--");
const marketplaceArgument = positional.shift();
let installerPackage = null;
let installerCli = null;
while (positional.length > 0) {
  const option = positional.shift();
  if (option === "--installer-package" && positional[0]) {
    installerPackage = positional.shift();
    continue;
  }
  if (option === "--installer-cli" && positional[0]) {
    installerCli = resolve(positional.shift());
    continue;
  }
  throw new Error(`unknown option: ${option}`);
}
if (installerPackage && installerCli) {
  throw new Error(
    "--installer-package and --installer-cli are mutually exclusive",
  );
}
if (!marketplaceArgument) {
  throw new Error(
    "usage: verify-release-hosts.mjs <marketplace-directory> [--installer-package <npm-spec> | --installer-cli <file>]",
  );
}

const marketplaceRoot = resolve(marketplaceArgument);
if (!existsSync(marketplaceRoot)) {
  throw new Error(`marketplace does not exist: ${marketplaceRoot}`);
}
const release = JSON.parse(
  readFileSync(join(marketplaceRoot, "release.json"), "utf8"),
);
if (typeof release.version !== "string") {
  throw new Error("release marketplace does not declare a version");
}

const temp = mkdtempSync(join(tmpdir(), "vibehub-release-hosts-"));

function run(command, args, env, cwd = temp, input) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 600_000,
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
  const codexHome = join(temp, "codex-home");
  const codexUserHome = join(temp, "codex-user-home");
  mkdirSync(claudeConfig, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(codexUserHome, { recursive: true });
  const hostEnv = {
    ...process.env,
    HOME: claudeHome,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
  };
  let installerReceipt = null;
  if (installerPackage || installerCli) {
    const installerCommand = installerPackage ? "npx" : process.execPath;
    const installerPrefix = installerPackage
      ? ["--yes", installerPackage]
      : [installerCli];
    installerReceipt = JSON.parse(
      run(
        installerCommand,
        [
          ...installerPrefix,
          "host",
          "install",
          "--hosts",
          "all",
          "--version",
          release.version,
          "--source",
          marketplaceRoot,
          "--install-dir",
          join(temp, "distribution"),
          "--json",
        ],
        {
          ...hostEnv,
          NPM_CONFIG_CACHE: join(temp, "installer-npm-cache"),
        },
      ),
    );
    if (
      installerReceipt.ok !== true ||
      installerReceipt.version !== release.version ||
      installerReceipt.distribution?.source !== "local" ||
      installerReceipt.hosts?.claude?.version !== release.version ||
      installerReceipt.hosts?.codex?.version !== release.version
    ) {
      throw new Error(
        `host installer returned an incomplete receipt: ${JSON.stringify(installerReceipt)}`,
      );
    }
  } else {
    run("claude", ["plugin", "validate", "--strict", marketplaceRoot], hostEnv);
    run(
      "claude",
      ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"],
      hostEnv,
    );
    run(
      "claude",
      ["plugin", "install", "vibehub@vibehub", "--scope", "user"],
      hostEnv,
    );
  }
  const claudePlugins = JSON.parse(
    run("claude", ["plugin", "list", "--json"], hostEnv),
  );
  const claudePlugin = claudePlugins.find(
    (plugin) => plugin.id === "vibehub@vibehub",
  );
  if (
    !claudePlugin?.enabled ||
    claudePlugin.version !== release.version ||
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
  run("git", ["init", "-q", "-b", "main"], hostEnv, repo);
  run(
    "git",
    ["-c", "user.email=release@vibehub.local", "-c", "user.name=VibeHub Release", "commit", "-q", "--allow-empty", "-m", "seed"],
    hostEnv,
    repo,
  );
  const runtimeEnv = {
    ...hostEnv,
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

  const codexEnv = installerReceipt
    ? hostEnv
    : {
        ...hostEnv,
        HOME: codexUserHome,
      };
  const codexBin = process.env.CODEX_BIN || "codex";
  let codexInstalledRoot;
  let codexPlugins;
  if (installerReceipt) {
    codexPlugins = JSON.parse(
      run(codexBin, ["plugin", "list", "--available", "--json"], codexEnv),
    );
    const installedEntry = codexPlugins.installed?.find(
      (plugin) => plugin.pluginId === "vibehub@vibehub",
    );
    if (
      installedEntry?.enabled !== true ||
      installedEntry.version !== release.version
    ) {
      throw new Error(
        "Codex did not retain the installer-managed VibeHub plugin",
      );
    }
    let installedPath =
      installedEntry.installedPath ?? installedEntry.source?.path;
    if (typeof installedPath !== "string" || !existsSync(installedPath)) {
      const codexMaterialized = JSON.parse(
        run(
          codexBin,
          ["plugin", "add", "vibehub@vibehub", "--json"],
          codexEnv,
        ),
      );
      installedPath = codexMaterialized.installedPath;
    }
    if (typeof installedPath !== "string" || !existsSync(installedPath)) {
      throw new Error("Codex did not report its installed plugin cache");
    }
    codexInstalledRoot = realpathSync(installedPath);
  } else {
    JSON.parse(
      run(
        codexBin,
        ["plugin", "marketplace", "add", marketplaceRoot, "--json"],
        codexEnv,
      ),
    );
    const codexInstall = JSON.parse(
      run(
        codexBin,
        ["plugin", "add", "vibehub@vibehub", "--json"],
        codexEnv,
      ),
    );
    if (
      typeof codexInstall.installedPath !== "string" ||
      !existsSync(codexInstall.installedPath)
    ) {
      throw new Error("Codex did not materialize vibehub@vibehub");
    }
    codexInstalledRoot = realpathSync(codexInstall.installedPath);
    codexPlugins = JSON.parse(
      run(
        codexBin,
        ["plugin", "list", "--available", "--json"],
        codexEnv,
      ),
    );
  }
  const codexSerialized = JSON.stringify(codexPlugins);
  if (!codexSerialized.includes("vibehub")) {
    throw new Error("Codex did not expose vibehub@vibehub from the release catalog");
  }
  const codexRuntimeEnv = {
    ...codexEnv,
    NPM_CONFIG_CACHE: join(temp, "npm-cache"),
    VIBEHUB_RUNTIME_DIR: join(temp, "codex-public-npm-runtime"),
  };
  await verifyCodexHostStartsMcp(codexBin, codexRuntimeEnv, repo, {
    timeoutMs: 600_000,
  });
  const codexHooks = JSON.parse(
    readFileSync(join(codexInstalledRoot, "codex", "hooks.json"), "utf8"),
  );
  const codexSession = codexHooks.hooks.SessionStart[0].hooks[0];
  const codexHookOutput = JSON.parse(
    run(
      "/bin/sh",
      ["-c", codexSession.command],
      {
        ...codexRuntimeEnv,
        CLAUDE_PLUGIN_ROOT: codexInstalledRoot,
        PLUGIN_ROOT: codexInstalledRoot,
      },
      repo,
      JSON.stringify({
        session_id: "public-codex-release-verification",
        transcript_path: null,
        cwd: repo,
        hook_event_name: "SessionStart",
        model: "gpt-5",
        permission_mode: "default",
        source: "startup",
      }),
    ),
  );
  if (
    !codexHookOutput.hookSpecificOutput?.additionalContext?.includes(
      "register_scope",
    )
  ) {
    throw new Error(
      "installed Codex plugin did not emit the shared SessionStart protocol",
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      marketplaceRoot,
      claude: "installed",
      runtime: "public npm",
      codex: "installed and MCP ready",
      installer:
        installerPackage ?? installerCli ?? "direct host commands",
    })}\n`,
  );
} finally {
  if (process.env.VIBEHUB_KEEP_TMP === "1") {
    process.stderr.write(`kept release host verification at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
