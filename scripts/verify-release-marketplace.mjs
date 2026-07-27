#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const positional = process.argv.slice(2).filter((arg) => arg !== "--");
const marketplaceRoot = resolve(positional[0] ?? "");
if (!positional[0] || positional.length !== 1) {
  throw new Error("usage: verify-release-marketplace.mjs <marketplace-directory>");
}

const pluginRoot = join(marketplaceRoot, "plugins", "vibehub");
const release = readJson(join(marketplaceRoot, "release.json"));
const identity = readReleaseIdentity(root);
if (
  release.schemaVersion !== 2 ||
  release.name !== identity.name ||
  release.version !== identity.version ||
  release.channel !== "npm" ||
  JSON.stringify(release.runtime?.packages) !==
    JSON.stringify([
      `@vw-ai/core@${identity.version}`,
      `@vw-ai/cli@${identity.version}`,
      `@vw-ai/workbench-mcp@${identity.version}`,
    ])
) {
  throw new Error("release provenance does not match the npm runtime identity");
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
if (codexManifest.interface?.brandColor !== "#3E7D4C") {
  throw new Error("Codex marketplace brand color does not match the VibeHub identity");
}

if (!existsSync(join(pluginRoot, "runtime", "vibehub-runtime.mjs"))) {
  throw new Error("thin npm runtime launcher is missing");
}
for (const forbidden of ["packages", "node_modules"]) {
  if (existsSync(join(pluginRoot, forbidden))) {
    throw new Error(`thin release must not contain ${forbidden}`);
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

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    marketplaceRoot,
    version: release.version,
    channel: release.channel,
    artifact: "thin",
  })}\n`,
);
