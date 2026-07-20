#!/usr/bin/env node
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJson,
  readReleaseIdentity,
  targetFor,
} from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const positional = process.argv.slice(2).filter((arg) => arg !== "--");
const marketplaceRoot = resolve(positional[0] ?? "");
if (!positional[0] || positional.length !== 1) {
  throw new Error("usage: verify-release-marketplace.mjs <marketplace-directory>");
}

const pluginRoot = join(marketplaceRoot, "plugins", "vibehub");
const release = readJson(join(marketplaceRoot, "release.json"));
const identity = readReleaseIdentity(root);
const expectedTarget = targetFor(
  process.platform,
  process.arch,
  Number(process.versions.node.split(".")[0]),
);

if (
  release.name !== identity.name ||
  release.version !== identity.version ||
  release.target !== expectedTarget ||
  release.platform !== process.platform ||
  release.arch !== process.arch ||
  release.node?.major !== Number(process.versions.node.split(".")[0]) ||
  release.node?.abi !== process.versions.modules
) {
  throw new Error("release provenance does not match the verifier runtime or source identity");
}

const claude = readJson(
  join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
);
const codex = readJson(
  join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
);
const claudeManifest = readJson(join(pluginRoot, ".claude-plugin", "plugin.json"));
const codexManifest = readJson(join(pluginRoot, ".codex-plugin", "plugin.json"));

if (
  claude.name !== "vibehub" ||
  claude.version !== identity.version ||
  claude.plugins?.length !== 1 ||
  claude.plugins[0].name !== "vibehub" ||
  claude.plugins[0].version !== identity.version ||
  claude.plugins[0].source !== "./plugins/vibehub"
) {
  throw new Error("Claude public marketplace identity or source is invalid");
}
if (
  codex.name !== "vibehub" ||
  codex.plugins?.length !== 1 ||
  codex.plugins[0].name !== "vibehub" ||
  codex.plugins[0].source?.source !== "local" ||
  codex.plugins[0].source?.path !== "./plugins/vibehub"
) {
  throw new Error("Codex public marketplace identity or source is invalid");
}
if (
  claudeManifest.version !== identity.version ||
  codexManifest.version !== identity.version
) {
  throw new Error("packaged host manifest versions do not match the release");
}

for (const entrypoint of [
  "packages/cli/dist/main.js",
  "packages/mcp/dist/stdio.js",
]) {
  if (!existsSync(join(pluginRoot, entrypoint))) {
    throw new Error(`packaged entrypoint is missing: ${entrypoint}`);
  }
}

const canonicalRoot = realpathSync(marketplaceRoot);
const pending = [marketplaceRoot];
while (pending.length > 0) {
  const current = pending.pop();
  for (const entry of readdirSync(current)) {
    const child = join(current, entry);
    const stat = lstatSync(child);
    if (stat.isDirectory()) pending.push(child);
    if (stat.isSymbolicLink()) {
      const destination = realpathSync(child);
      const destinationRelative = relative(canonicalRoot, destination);
      if (
        destinationRelative.startsWith("..") ||
        isAbsolute(destinationRelative)
      ) {
        throw new Error(`release symlink escapes marketplace: ${child}`);
      }
    }
  }
}

const requireFromCli = createRequire(join(pluginRoot, "packages", "cli", "package.json"));
const Database = requireFromCli("better-sqlite3");
const database = new Database(":memory:");
database.exec("CREATE TABLE release_smoke (ok INTEGER NOT NULL)");
database.prepare("INSERT INTO release_smoke (ok) VALUES (?)").run(1);
const row = database.prepare("SELECT ok FROM release_smoke").get();
database.close();
if (row?.ok !== 1) {
  throw new Error("packaged better-sqlite3 failed the release smoke");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    marketplaceRoot,
    version: release.version,
    target: release.target,
    nativeDatabase: "loaded",
  })}\n`,
);
