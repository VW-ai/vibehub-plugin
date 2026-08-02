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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_PATHS = [
  ".claude-plugin",
  ".codex-plugin",
  "assets/brand",
  "CHANGELOG.md",
  "docs/INSTALL.md",
  "docs/LOCAL_GRAPH_DESIGN.md",
  "docs/RELEASE.md",
  "docs/assets/local-graph/quiet-workbench-desktop.jpg",
  "skills",
  "LICENSE",
  "README.md",
];

export function artifactStats(artifactRoot) {
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
  return { files, bytes };
}

export function buildPluginArtifact({ sourceRoot = root, artifactRoot } = {}) {
  if (!artifactRoot) throw new Error("artifactRoot is required");
  if (existsSync(artifactRoot)) throw new Error(`artifact output already exists: ${artifactRoot}`);
  mkdirSync(artifactRoot, { recursive: true });
  for (const relativePath of PLUGIN_PATHS) {
    const target = join(artifactRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(sourceRoot, relativePath), target, { recursive: true });
  }
  return { artifactRoot, ...artifactStats(artifactRoot) };
}

function parseArgs(argv) {
  const index = argv.indexOf("--out");
  if (index < 0 || !argv[index + 1]) {
    throw new Error("Usage: build-plugin-artifact.mjs --out <empty-directory>");
  }
  if (argv.length !== 2) throw new Error(`Unknown arguments: ${argv.join(" ")}`);
  return resolve(argv[index + 1]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = buildPluginArtifact({ artifactRoot: parseArgs(process.argv.slice(2)) });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
