import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("production DSH adapter pins the exact rc.8 baseline", async () => {
  const lock = JSON.parse(await read("packages/dsh-adapter/upstream-lock.json"));
  assert.deepEqual(
    {
      commit: lock.commit,
      version: lock.version,
      package: lock.package,
      tag: lock.distributionTag,
    },
    {
      commit: "141eb6fef83422698aef7a981029e843e8161534",
      version: "0.1.0-rc.8",
      package: "@deepseek-ai/dsh@0.1.0-rc.8",
      tag: "next",
    },
  );
  assert.match(lock.node, /22\.19\.0/);
});

test("production source probe covers every imported DSH compatibility seam", async () => {
  const sourceRoot = process.env.DSH_SOURCE_ROOT;
  if (!sourceRoot) return test.skip("set DSH_SOURCE_ROOT to the exact official checkout");
  const stdout = execFileSync(
    process.execPath,
    ["packages/dsh-adapter/probe-source.mjs", sourceRoot],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.checks.length, 14);
  assert.equal(result.checks.every((check) => check.proven), true);
});
