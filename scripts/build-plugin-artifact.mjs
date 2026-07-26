#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_PLUGIN_PATHS = [
  ".claude-plugin",
  ".codex-plugin",
  ".mcp.json",
  "codex",
  "hooks",
  "skills",
  "LICENSE",
  "README.md",
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

function removeLegacyBacklinks(artifactRoot) {
  for (const backlink of [
    join(artifactRoot, "packages/cli/node_modules/.pnpm/node_modules/@vibehub/cli"),
    join(
      artifactRoot,
      "packages/mcp/node_modules/.pnpm/node_modules/@vibehub/workbench-mcp",
    ),
  ]) {
    try {
      unlinkSync(backlink);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function sanitizeAndAssertSelfContained(packageRoot, artifactRoot) {
  const modules = join(packageRoot, "node_modules");
  if (!existsSync(modules)) {
    throw new Error(`deployed package has no node_modules: ${packageRoot}`);
  }
  const canonicalArtifactRoot = realpathSync(artifactRoot);
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
          if (resolved.startsWith("/var/")) resolved = `/private${resolved}`;
        }
        if (relative(canonicalArtifactRoot, resolved).startsWith("..")) {
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

function assertArtifactBudget(artifactRoot) {
  const pending = [artifactRoot];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const child = join(current, entry);
      const stat = lstatSync(child);
      if (stat.isDirectory()) pending.push(child);
      else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
      }
    }
  }
  const maxFiles = 8_000;
  const maxBytes = 100 * 1024 * 1024;
  if (files > maxFiles || bytes > maxBytes) {
    throw new Error(
      `plugin artifact exceeds release budget: ${files} files, ${bytes} bytes`,
    );
  }
}

export function buildPluginArtifact({
  sourceRoot = scriptRoot,
  artifactRoot,
  offline = process.env.VIBEHUB_OFFLINE === "1",
} = {}) {
  if (!artifactRoot) throw new Error("artifactRoot is required");
  if (existsSync(artifactRoot)) {
    throw new Error(`artifact output already exists: ${artifactRoot}`);
  }
  mkdirSync(artifactRoot, { recursive: true });
  for (const relativePath of STATIC_PLUGIN_PATHS) {
    cpSync(join(sourceRoot, relativePath), join(artifactRoot, relativePath), {
      recursive: true,
    });
  }

  const deployArgs = offline ? ["--offline"] : [];
  run(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      ...deployArgs,
      "--filter",
      "@vibehub/cli",
      "--prod",
      "deploy",
      "--legacy",
      join(artifactRoot, "packages/cli"),
    ],
    sourceRoot,
  );
  run(
    "pnpm",
    [
      "--config.node-linker=hoisted",
      ...deployArgs,
      "--filter",
      "@vibehub/workbench-mcp",
      "--prod",
      "deploy",
      "--legacy",
      join(artifactRoot, "packages/mcp"),
    ],
    sourceRoot,
  );

  removeLegacyBacklinks(artifactRoot);
  sanitizeAndAssertSelfContained(join(artifactRoot, "packages/cli"), artifactRoot);
  sanitizeAndAssertSelfContained(join(artifactRoot, "packages/mcp"), artifactRoot);
  assertArtifactBudget(artifactRoot);
  return artifactRoot;
}

function parseCli(argv) {
  let out = null;
  let offline = process.env.VIBEHUB_OFFLINE === "1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") out = argv[++index] ?? null;
    else if (arg === "--offline") offline = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("usage: build-plugin-artifact.mjs --out <empty-directory> [--offline]");
  return { out: resolve(out), offline };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  buildPluginArtifact({ artifactRoot: options.out, offline: options.offline });
  process.stdout.write(`${JSON.stringify({ ok: true, artifactRoot: options.out })}\n`);
}
