#!/usr/bin/env node
import {
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "npm");
const identity = readReleaseIdentity(root);
const packages = [
  {
    name: "@vibehub/core",
    directory: "packages/core",
    archive: `vibehub-core-${identity.version}.tgz`,
  },
  {
    name: "@vibehub/cli",
    directory: "packages/cli",
    archive: `vibehub-cli-${identity.version}.tgz`,
  },
  {
    name: "@vibehub/workbench-mcp",
    directory: "packages/mcp",
    archive: `vibehub-workbench-mcp-${identity.version}.tgz`,
  },
];

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

for (const entry of packages) {
  const result = spawnSync(
    "pnpm",
    [
      "-C",
      join(root, entry.directory),
      "pack",
      "--pack-destination",
      output,
    ],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to pack ${entry.name}`);
  }
  const archivePath = join(output, entry.archive);
  if (!statSync(archivePath).isFile()) {
    throw new Error(`pnpm did not create ${archivePath}`);
  }
}

const manifest = {
  version: identity.version,
  tag: `v${identity.version}`,
  packages: packages.map((entry) => ({
    name: entry.name,
    version: identity.version,
    archive: entry.archive,
  })),
};
writeFileSync(
  join(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
