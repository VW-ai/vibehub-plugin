import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON at ${path}: ${error.message}`);
  }
}

export function isSemver(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    version,
  );
}

export function readReleaseIdentity(root) {
  const rootPackage = readJson(join(root, "package.json"));
  const corePackage = readJson(join(root, "packages", "core", "package.json"));
  const cliPackage = readJson(join(root, "packages", "cli", "package.json"));
  const mcpPackage = readJson(join(root, "packages", "mcp", "package.json"));
  const claudeManifest = readJson(
    join(root, ".claude-plugin", "plugin.json"),
  );
  const codexManifest = readJson(join(root, ".codex-plugin", "plugin.json"));
  const claudeMarketplace = readJson(
    join(root, ".claude-plugin", "marketplace.json"),
  );
  const codexMarketplace = readJson(
    join(root, ".agents", "plugins", "marketplace.json"),
  );
  const versions = new Set([
    rootPackage.version,
    corePackage.version,
    cliPackage.version,
    mcpPackage.version,
    claudeManifest.version,
    codexManifest.version,
    claudeMarketplace.version,
    claudeMarketplace.plugins?.[0]?.version,
  ]);
  if (versions.size !== 1) {
    throw new Error(
      `release versions differ: root=${rootPackage.version}, core=${corePackage.version}, CLI=${cliPackage.version}, MCP=${mcpPackage.version}, Claude=${claudeManifest.version}, Codex=${codexManifest.version}`,
    );
  }
  if (claudeManifest.name !== "vibehub" || codexManifest.name !== "vibehub") {
    throw new Error("both host manifests must use the stable plugin name vibehub");
  }
  if (
    claudeMarketplace.name !== "vibehub" ||
    claudeMarketplace.plugins?.[0]?.name !== "vibehub" ||
    claudeMarketplace.plugins[0].source !== "./" ||
    codexMarketplace.name !== "vibehub" ||
    codexMarketplace.plugins?.[0]?.name !== "vibehub" ||
    codexMarketplace.plugins[0].source?.path !== "."
  ) {
    throw new Error("root marketplace catalogs must publish the VibeHub plugin from main");
  }
  if (!isSemver(rootPackage.version)) {
    throw new Error(`release version is not SemVer: ${rootPackage.version}`);
  }
  return {
    name: "vibehub",
    version: rootPackage.version,
    rootPackage,
    corePackage,
    cliPackage,
    mcpPackage,
    claudeManifest,
    codexManifest,
    claudeMarketplace,
    codexMarketplace,
  };
}
