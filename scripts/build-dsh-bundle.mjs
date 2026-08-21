#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginArtifact } from "./build-plugin-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildDshBundle({ sourceRoot = root, artifactRoot, clean = false } = {}) {
  if (!artifactRoot) throw new Error("artifactRoot is required");
  if (existsSync(artifactRoot)) {
    if (!clean) throw new Error(`artifact output already exists: ${artifactRoot}`);
    const existingManifestPath = join(artifactRoot, "package.json");
    let existing;
    try {
      existing = JSON.parse(readFileSync(existingManifestPath, "utf8"));
    } catch {
      throw new Error(`refusing to clean unrecognized artifact output: ${artifactRoot}`);
    }
    if (existing.name !== "@vibehub/dsh-vibehub") {
      throw new Error(`refusing to clean non-VibeHub artifact output: ${artifactRoot}`);
    }
    rmSync(artifactRoot, { recursive: true, force: true });
  }
  mkdirSync(artifactRoot, { recursive: true });
  for (const file of ["package.json", "cordis.patch.yml", "index.js"]) {
    cpSync(join(sourceRoot, "packages/dsh-bundle", file), join(artifactRoot, file));
  }
  mkdirSync(join(artifactRoot, "adapter"), { recursive: true });
  cpSync(
    join(sourceRoot, "packages/dsh-adapter/client.js"),
    join(artifactRoot, "adapter/client.js"),
  );
  cpSync(
    join(sourceRoot, "packages/dsh-adapter/host.js"),
    join(artifactRoot, "adapter/host.js"),
  );
  cpSync(
    join(sourceRoot, "packages/dsh-adapter/linkage.mjs"),
    join(artifactRoot, "adapter/linkage.mjs"),
  );
  buildPluginArtifact({ sourceRoot, artifactRoot: join(artifactRoot, "vendor") });
  const manifestPath = join(artifactRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.private = false;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--out");
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error("Usage: build-dsh-bundle.mjs --out <directory> [--clean]");
  }
  const result = buildDshBundle({
    artifactRoot: resolve(process.argv[index + 1]),
    clean: process.argv.includes("--clean"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
