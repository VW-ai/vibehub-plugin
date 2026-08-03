#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

export function readReleaseIdentity() {
  const packageJson = readJson("package.json");
  const codex = readJson(".codex-plugin/plugin.json");
  const claude = readJson(".claude-plugin/plugin.json");
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const versions = {
    package: packageJson.version,
    codex: codex.version,
    claude: claude.version,
    marketplace: marketplace.version,
    marketplacePlugin: marketplace.plugins?.[0]?.version,
  };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1 || unique.has(undefined)) {
    throw new Error(`release versions do not match: ${JSON.stringify(versions)}`);
  }
  if (packageJson.private !== true) throw new Error("package.json must remain private");
  if (packageJson.dependencies || packageJson.devDependencies) {
    throw new Error("release package must remain dependency-free");
  }
  return { version: packageJson.version, versions };
}

export function verifyReleaseTag(tag) {
  const identity = readReleaseIdentity();
  if (tag && tag !== `v${identity.version}`) {
    throw new Error(`tag ${tag} does not match v${identity.version}`);
  }
  return { ...identity, tag: tag || null };
}

function parseTag(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 2 && argv[0] === "--tag") return argv[1];
  throw new Error("Usage: verify-release-version.mjs [--tag vX.Y.Z]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...verifyReleaseTag(parseTag(process.argv.slice(2))),
  })}\n`);
}
