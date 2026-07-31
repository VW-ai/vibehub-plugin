#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReleaseMarketplace } from "./build-release-marketplace.mjs";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const cli = join(root, "packages", "cli", "dist", "main.js");
if (!existsSync(cli)) {
  throw new Error("build @vw-ai/vibehub-cli before verifying the host installer");
}

const temp = mkdtempSync(join(tmpdir(), "vibehub-host-installer-"));

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: temp,
    env,
    encoding: "utf8",
    timeout: 120_000,
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
  const marketplace = buildReleaseMarketplace({
    outputRoot: join(temp, "release"),
    commit: "host-installer-verification",
  });
  const home = join(temp, "home");
  const claudeConfig = join(home, ".claude");
  const codexHome = join(temp, "codex-home");
  const installDir = join(temp, "distribution");
  mkdirSync(claudeConfig, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
  };
  const args = [
    cli,
    "host",
    "install",
    "--hosts",
    "all",
    "--version",
    identity.version,
    "--source",
    marketplace.outputRoot,
    "--install-dir",
    installDir,
    "--json",
  ];
  const first = JSON.parse(run(process.execPath, args, env));
  if (
    first.ok !== true ||
    first.version !== identity.version ||
    first.distribution?.changed !== true ||
    first.hosts?.claude?.status !== "installed" ||
    first.hosts?.codex?.status !== "installed"
  ) {
    throw new Error(`first host installation was not complete: ${JSON.stringify(first)}`);
  }
  const second = JSON.parse(run(process.execPath, args, env));
  if (
    second.ok !== true ||
    second.distribution?.changed !== false ||
    second.hosts?.claude?.status !== "updated" ||
    second.hosts?.codex?.status !== "updated"
  ) {
    throw new Error(`repeated host installation did not converge: ${JSON.stringify(second)}`);
  }

  const claude = JSON.parse(
    run("claude", ["plugin", "list", "--json"], env),
  ).find((plugin) => plugin.id === "vibehub@vibehub");
  if (!claude?.enabled || claude.version !== identity.version) {
    throw new Error("Claude did not retain the installer-managed VibeHub plugin");
  }
  const codex = JSON.parse(
    run(
      process.env.CODEX_BIN || "codex",
      ["plugin", "list", "--available", "--json"],
      env,
    ),
  ).installed?.find((plugin) => plugin.pluginId === "vibehub@vibehub");
  if (!codex?.enabled || codex.version !== identity.version) {
    throw new Error("Codex did not retain the installer-managed VibeHub plugin");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: identity.version,
      installer: "idempotent",
      claude: "installed",
      codex: "installed",
    })}\n`,
  );
} finally {
  if (process.env.VIBEHUB_KEEP_TMP === "1") {
    process.stderr.write(`kept host installer verification at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
