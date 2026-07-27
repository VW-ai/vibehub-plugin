#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = JSON.parse(
  readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
);
const version = plugin.version;
const mode = process.argv[2];
const forwardedArgs = process.argv.slice(3);

if (!["cli", "mcp"].includes(mode)) {
  throw new Error("usage: vibehub-runtime.mjs <cli|mcp> [...args]");
}

const runtimeRoot = process.env.VIBEHUB_RUNTIME_DIR
  ? resolve(process.env.VIBEHUB_RUNTIME_DIR)
  : join(homedir(), ".vibehub", "runtime", "npm", `v${version}`);
const runtimeParent = dirname(runtimeRoot);
const lockRoot = `${runtimeRoot}.installing`;
const expected = [
  {
    name: "@vibehub/core",
    manifest: join(runtimeRoot, "node_modules", "@vibehub", "core", "package.json"),
  },
  {
    name: "@vibehub/cli",
    manifest: join(runtimeRoot, "node_modules", "@vibehub", "cli", "package.json"),
  },
  {
    name: "@vibehub/workbench-mcp",
    manifest: join(
      runtimeRoot,
      "node_modules",
      "@vibehub",
      "workbench-mcp",
      "package.json",
    ),
  },
];

function runtimeIsCurrent() {
  try {
    return expected.every(
      (entry) =>
        JSON.parse(readFileSync(entry.manifest, "utf8")).version === version,
    );
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function installSpecs() {
  if (process.env.VIBEHUB_RUNTIME_PACKAGE_SPECS) {
    const specs = JSON.parse(process.env.VIBEHUB_RUNTIME_PACKAGE_SPECS);
    if (
      !Array.isArray(specs) ||
      specs.length !== 3 ||
      !specs.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(
        "VIBEHUB_RUNTIME_PACKAGE_SPECS must contain core, CLI, and MCP package specs",
      );
    }
    return specs;
  }
  return expected.map((entry) => `${entry.name}@${version}`);
}

function acquireInstallLock() {
  mkdirSync(runtimeParent, { recursive: true });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockRoot);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (runtimeIsCurrent()) return false;
      try {
        if (Date.now() - statSync(lockRoot).mtimeMs > 300_000) {
          rmSync(lockRoot, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      wait(200);
    }
  }
  throw new Error(`timed out waiting for VibeHub runtime installation at ${runtimeRoot}`);
}

function ensureRuntime() {
  if (runtimeIsCurrent()) return;
  const ownsLock = acquireInstallLock();
  if (!ownsLock) return;

  let stage = null;
  try {
    if (runtimeIsCurrent()) return;
    stage = mkdtempSync(join(runtimeParent, `.v${version}-stage-`));
    writeFileSync(
      join(stage, "package.json"),
      `${JSON.stringify({ private: true }, null, 2)}\n`,
    );
    const npm = process.env.VIBEHUB_NPM_BIN || "npm";
    const result = spawnSync(
      npm,
      [
        "install",
        "--prefix",
        stage,
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        ...installSpecs(),
      ],
      { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `npm runtime installation failed (${result.status})\n${result.stdout}\n${result.stderr}`,
      );
    }

    for (const entry of expected) {
      const stagedManifest = entry.manifest.replace(runtimeRoot, stage);
      const installed = JSON.parse(readFileSync(stagedManifest, "utf8"));
      if (installed.version !== version) {
        throw new Error(
          `npm installed ${entry.name}@${installed.version}; expected ${version}`,
        );
      }
    }

    const stagedCore = join(
      stage,
      "node_modules",
      "@vibehub",
      "core",
      "dist",
      "index.js",
    );
    const smoke = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "const m=await import(process.argv[1]);const db=m.openDb(':memory:');db.close();",
        pathToFileURL(stagedCore).href,
      ],
      { encoding: "utf8" },
    );
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0) {
      throw new Error(
        `installed VibeHub runtime failed its SQLite smoke test\n${smoke.stdout}\n${smoke.stderr}`,
      );
    }

    if (existsSync(runtimeRoot)) {
      rmSync(runtimeRoot, { recursive: true, force: true });
    }
    renameSync(stage, runtimeRoot);
    stage = null;
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true });
    rmSync(lockRoot, { recursive: true, force: true });
  }
}

try {
  ensureRuntime();
} catch (error) {
  if (mode === "cli" && forwardedArgs[0] === "hook") {
    process.stderr.write(
      `[vibehub] runtime unavailable; hook skipped: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(0);
  }
  throw error;
}

const entrypoint =
  mode === "cli"
    ? join(runtimeRoot, "node_modules", "@vibehub", "cli", "dist", "main.js")
    : join(
        runtimeRoot,
        "node_modules",
        "@vibehub",
        "workbench-mcp",
        "dist",
        "stdio.js",
      );
const child = spawn(process.execPath, [entrypoint, ...forwardedArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
const outcome = await new Promise((resolveChild, rejectChild) => {
  child.once("error", rejectChild);
  child.once("exit", (status, signal) => resolveChild({ status, signal }));
});
if (outcome.signal) {
  process.kill(process.pid, outcome.signal);
} else {
  process.exit(outcome.status ?? 1);
}
