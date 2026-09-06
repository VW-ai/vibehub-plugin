#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_PATHS } from "./build-plugin-artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function readJson(sourceRoot, path) {
  return JSON.parse(readFileSync(join(sourceRoot, path), "utf8"));
}

export function parseReleaseVersion(version) {
  const match = VERSION.exec(version ?? "");
  if (!match) throw new Error(`invalid release version: ${JSON.stringify(version)}`);
  return {
    version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function compareReleaseCore(left, right) {
  const a = typeof left === "string" ? parseReleaseVersion(left) : left;
  const b = typeof right === "string" ? parseReleaseVersion(right) : right;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function readReleaseIdentity(sourceRoot = root) {
  // Two of the five declarations this used to compare came from marketplace
  // manifests. Marketplace distribution is retired, so the surviving identity
  // is package.json, the Claude plugin manifest, and the tag.
  const packageJson = readJson(sourceRoot, "package.json");
  const claude = readJson(sourceRoot, ".claude-plugin/plugin.json");
  const versions = {
    package: packageJson.version,
    claude: claude.version,
  };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1 || unique.has(undefined)) {
    throw new Error(`release versions do not match: ${JSON.stringify(versions)}`);
  }
  if (packageJson.private !== true) throw new Error("package.json must remain private");
  if (packageJson.dependencies || packageJson.devDependencies) {
    throw new Error("release package must remain dependency-free");
  }
  parseReleaseVersion(packageJson.version);
  return { version: packageJson.version, versions };
}

export function verifyReleaseTag(tag, sourceRoot = root) {
  const identity = readReleaseIdentity(sourceRoot);
  if (tag && tag !== `v${identity.version}`) {
    throw new Error(`tag ${tag} does not match v${identity.version}`);
  }
  return { ...identity, tag: tag || null };
}

export function latestReachableStableTag(sourceRoot = root) {
  const output = execFileSync(
    "git",
    ["-C", sourceRoot, "tag", "--merged", "HEAD", "--list", "v*"],
    { encoding: "utf8" },
  );
  const stable = output.trim().split("\n").filter(Boolean).flatMap((tag) => {
    try {
      const parsed = parseReleaseVersion(tag.slice(1));
      return tag.startsWith("v") && parsed.prerelease === null ? [{ tag, parsed }] : [];
    } catch {
      return [];
    }
  });
  stable.sort((left, right) => compareReleaseCore(right.parsed, left.parsed));
  return stable[0]?.tag ?? null;
}

export function shippedContentChanged(sourceRoot, baselineTag) {
  const result = spawnSync(
    "git",
    ["-C", sourceRoot, "diff", "--quiet", baselineTag, "--", ...PLUGIN_PATHS],
    { encoding: "utf8" },
  );
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error(`cannot compare shipped content with ${baselineTag}: ${(result.stderr || result.stdout).trim()}`);
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function verifyShippedContentVersion({ sourceRoot = root, baselineTag = null } = {}) {
  const identity = readReleaseIdentity(sourceRoot);
  const current = parseReleaseVersion(identity.version);
  const resolvedBaseline = baselineTag ?? latestReachableStableTag(sourceRoot);
  if (!resolvedBaseline) {
    return { ...identity, baselineTag: null, shippedContentChanged: null };
  }
  if (!resolvedBaseline.startsWith("v")) throw new Error(`invalid stable baseline tag: ${resolvedBaseline}`);
  const baseline = parseReleaseVersion(resolvedBaseline.slice(1));
  if (baseline.prerelease !== null) throw new Error(`baseline tag must be stable: ${resolvedBaseline}`);
  const changed = shippedContentChanged(sourceRoot, resolvedBaseline);
  const comparison = compareReleaseCore(current, baseline);
  if (comparison < 0) {
    throw new Error(`declared version ${identity.version} is older than reachable release ${resolvedBaseline}`);
  }
  if (changed && comparison === 0) {
    throw new Error(
      `shipped content differs from ${resolvedBaseline}, but declared version ${identity.version} reuses that published release identity`,
    );
  }
  if (changed && comparison > 0) {
    const changelog = readFileSync(join(sourceRoot, "CHANGELOG.md"), "utf8");
    const hasUnreleased = /^## Unreleased\s*$/mu.test(changelog);
    if (current.prerelease !== null && !hasUnreleased) {
      throw new Error(`prerelease ${identity.version} requires an Unreleased changelog section`);
    }
    if (current.prerelease === null) {
      if (hasUnreleased) {
        throw new Error(`stable release candidate ${identity.version} must finalize the Unreleased changelog`);
      }
      const heading = new RegExp(`^## ${escapedPattern(identity.version)} — \\d{4}-\\d{2}-\\d{2}\\s*$`, "mu");
      if (!heading.test(changelog)) {
        throw new Error(`stable release candidate ${identity.version} needs a dated CHANGELOG heading`);
      }
    }
  }
  return {
    ...identity,
    baselineTag: resolvedBaseline,
    baselineVersion: baseline.version,
    shippedContentChanged: changed,
    releaseState: current.prerelease === null ? "stable" : "prerelease",
  };
}

function parseTag(argv) {
  if (argv.length === 0) return null;
  if (argv.length === 1 && argv[0] === "--check-shipped-content") return { checkShippedContent: true };
  if (argv.length === 2 && argv[0] === "--tag") return { tag: argv[1] };
  throw new Error("Usage: verify-release-version.mjs [--tag vX.Y.Z | --check-shipped-content]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = parseTag(process.argv.slice(2));
  const result = operation?.checkShippedContent
    ? verifyShippedContentVersion()
    : verifyReleaseTag(operation?.tag ?? null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...result,
  })}\n`);
}
