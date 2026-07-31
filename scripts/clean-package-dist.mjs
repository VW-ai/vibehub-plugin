#!/usr/bin/env node
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = realpathSync(join(repositoryRoot, "packages"));
const packageRoot = realpathSync(process.cwd());
const allowedPackages = new Set([
  "@vw-ai/vibehub-core",
  "@vw-ai/vibehub-cli",
  "@vw-ai/vibehub-workbench-mcp",
]);

if (dirname(packageRoot) !== packagesRoot) {
  throw new Error(
    `refusing to clean dist outside ${packagesRoot}: ${packageRoot}`,
  );
}

const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
if (!allowedPackages.has(manifest.name)) {
  throw new Error(`refusing to clean dist for unknown package ${manifest.name}`);
}

const distRoot = join(packageRoot, "dist");
if (dirname(distRoot) !== packageRoot) {
  throw new Error(`unsafe package dist path: ${distRoot}`);
}
rmSync(distRoot, { recursive: true, force: true });
