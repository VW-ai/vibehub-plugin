#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = join(root, "spikes/codex-app-server/dsh-bundle");
const output = resolve(process.argv[2] ?? join(root, "dist/dsh-codex-adapter-spike"));

if (output === root || output === dirname(root)) throw new Error("refusing broad artifact path");
if (readFileSync(join(source, "package.json"), "utf8").includes('"name": "@vibehub/dsh-codex-adapter-spike"') === false) {
  throw new Error("unrecognized spike source");
}
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "adapter"), { recursive: true });
for (const file of ["package.json", "cordis.patch.yml", "index.js"]) cpSync(join(source, file), join(output, file));
cpSync(join(root, "packages/codex-adapter/client.mjs"), join(output, "adapter/client.mjs"));
cpSync(join(root, "packages/codex-adapter/handoff.mjs"), join(output, "adapter/handoff.mjs"));
cpSync(join(root, "packages/codex-adapter/linkage.mjs"), join(output, "adapter/linkage.mjs"));
const manifestPath = join(output, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.private = false;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, output })}\n`);
