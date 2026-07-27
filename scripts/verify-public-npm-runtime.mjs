#!/usr/bin/env node
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readReleaseIdentity } from "./release-metadata.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const installRoot = mkdtempSync(join(tmpdir(), "vibehub-public-npm-"));
const specs = [
  `@vibehub/core@${identity.version}`,
  `@vibehub/cli@${identity.version}`,
  `@vibehub/workbench-mcp@${identity.version}`,
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? installRoot,
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: join(installRoot, "npm-cache"),
    },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

try {
  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  run("npm", ["install", "--omit=dev", "--no-fund", ...specs], {
    inherit: true,
  });
  run("npm", [
    "audit",
    "--omit=dev",
    "--audit-level=moderate",
  ], { inherit: true });

  const core = join(
    installRoot,
    "node_modules",
    "@vibehub",
    "core",
    "dist",
    "index.js",
  );
  run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      "const m = await import(process.argv[1]);",
      "const db = m.openDb(':memory:');",
      "db.exec('CREATE TABLE public_runtime (ok INTEGER NOT NULL)');",
      "db.close();",
    ].join(" "),
    core,
  ]);

  for (const spec of specs) {
    const [name] = spec.split(/@(?=\d)/);
    const packagePath = name.startsWith("@")
      ? name.split("/")
      : [name];
    const manifest = JSON.parse(
      readFileSync(
        join(installRoot, "node_modules", ...packagePath, "package.json"),
        "utf8",
      ),
    );
    if (manifest.version !== identity.version) {
      throw new Error(`${name} installed ${manifest.version}`);
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: identity.version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      nativeDatabase: "loaded",
    })}\n`,
  );
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
