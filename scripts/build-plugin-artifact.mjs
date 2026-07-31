#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC_PLUGIN_PATHS = [
  ".claude-plugin",
  ".codex-plugin",
  ".mcp.json",
  "codex",
  "docs/assets/ticket-system",
  "hooks",
  "runtime",
  "skills",
  "LICENSE",
  "README.md",
];

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
