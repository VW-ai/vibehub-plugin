#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const sourceRoot = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  process.stderr.write("Usage: node packages/codex-adapter/probe-dsh-source.mjs /absolute/path/to/deepseek-harness\n");
  process.exit(1);
}

const lock = JSON.parse(await readFile(new URL("./upstream-lock.json", import.meta.url), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
if (commit !== lock.dsh.commit) throw new Error(`expected DSH ${lock.dsh.commit}, received ${commit}`);

const checks = [];
for (const seam of lock.dsh.seams) {
  const source = await readFile(join(sourceRoot, seam.file), "utf8");
  const missing = seam.patterns.filter((pattern) => !source.includes(pattern));
  checks.push({ name: seam.name, file: seam.file, proven: missing.length === 0, missing });
}
if (checks.some((check) => !check.proven)) throw new Error(JSON.stringify(checks, null, 2));
process.stdout.write(`${JSON.stringify({ ok: true, commit, checks }, null, 2)}\n`);
