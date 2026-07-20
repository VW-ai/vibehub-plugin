import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_NODE_MAJOR = 24;
export const RELEASE_TARGETS = Object.freeze([
  "darwin-arm64-node24",
  "darwin-x64-node24",
  "linux-arm64-node24",
  "linux-x64-node24",
]);

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

export function targetFor(platform, arch, nodeMajor = RELEASE_NODE_MAJOR) {
  const target = `${platform}-${arch}-node${nodeMajor}`;
  if (!RELEASE_TARGETS.includes(target)) {
    throw new Error(
      `unsupported release target ${target}; expected one of ${RELEASE_TARGETS.join(", ")}`,
    );
  }
  return target;
}

export function readReleaseIdentity(root) {
  const rootPackage = readJson(join(root, "package.json"));
  const claudeManifest = readJson(
    join(root, ".claude-plugin", "plugin.json"),
  );
  const codexManifest = readJson(join(root, ".codex-plugin", "plugin.json"));
  const versions = new Set([
    rootPackage.version,
    claudeManifest.version,
    codexManifest.version,
  ]);
  if (versions.size !== 1) {
    throw new Error(
      `release versions differ: package=${rootPackage.version}, Claude=${claudeManifest.version}, Codex=${codexManifest.version}`,
    );
  }
  if (claudeManifest.name !== "vibehub" || codexManifest.name !== "vibehub") {
    throw new Error("both host manifests must use the stable plugin name vibehub");
  }
  if (!isSemver(rootPackage.version)) {
    throw new Error(`release version is not SemVer: ${rootPackage.version}`);
  }
  return {
    name: "vibehub",
    version: rootPackage.version,
    rootPackage,
    claudeManifest,
    codexManifest,
  };
}
