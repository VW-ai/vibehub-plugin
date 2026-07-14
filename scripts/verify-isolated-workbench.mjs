#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "vibehub-workbench-isolated-"));
const target = join(temp, basename(source));
const keep = process.env.VIBEHUB_KEEP_TMP === "1";

const excludedNames = new Set([
  "node_modules",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  ".pnpm-store",
]);

function run(command, args, cwd = target) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

try {
  cpSync(source, target, {
    recursive: true,
    filter(path) {
      if (path === source) return true;
      return !excludedNames.has(basename(path));
    },
  });

  const installArgs = ["install", "--frozen-lockfile"];
  if (process.env.VIBEHUB_OFFLINE === "1") installArgs.push("--offline");
  run("pnpm", installArgs);
  run("pnpm", ["verify"]);

  console.log(`isolated workbench: subtree-only install and complete verify matrix passed (${target})`);
} finally {
  if (keep) console.log(`kept isolated workbench at ${target}`);
  else rmSync(temp, { recursive: true, force: true });
}
