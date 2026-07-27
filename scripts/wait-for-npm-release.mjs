#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readReleaseIdentity } from "./release-metadata.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const suppliedTag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (suppliedTag !== `v${identity.version}`) {
  throw new Error(`expected release tag v${identity.version}; got ${suppliedTag}`);
}

const packages = [
  "@vibehub/core",
  "@vibehub/cli",
  "@vibehub/workbench-mcp",
];
const deadline = Date.now() + 15 * 60_000;

while (Date.now() < deadline) {
  const missing = packages.filter((name) => {
    const result = spawnSync(
      "npm",
      ["view", `${name}@${identity.version}`, "dist.integrity", "--json"],
      { encoding: "utf8" },
    );
    if (result.status !== 0) return true;
    try {
      const integrity = JSON.parse(result.stdout);
      return typeof integrity !== "string" || !integrity.startsWith("sha512-");
    } catch {
      return true;
    }
  });
  if (missing.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        version: identity.version,
        packages,
      })}\n`,
    );
    process.exit(0);
  }
  process.stderr.write(`waiting for npm: ${missing.join(", ")}\n`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
}

throw new Error(`timed out waiting for VibeHub ${identity.version} on npm`);
