#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginArtifact } from "./build-plugin-artifact.mjs";
import {
  readReleaseIdentity,
  RELEASE_NODE_MAJOR,
  targetFor,
} from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_MARKER = ".vibehub-release-marketplace";
const MARKETPLACE_NAME = "vibehub";

function parseCli(argv) {
  let out = null;
  let target = null;
  let commit = process.env.GITHUB_SHA ?? "local";
  let offline = process.env.VIBEHUB_OFFLINE === "1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--out") out = argv[++index] ?? "";
    else if (arg === "--target") target = argv[++index] ?? "";
    else if (arg === "--commit") commit = argv[++index] ?? "";
    else if (arg === "--offline") offline = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("--out requires a path");
  if (!target) {
    target = targetFor(process.platform, process.arch, Number(process.versions.node.split(".")[0]));
  }
  return { out: resolve(out), target, commit, offline };
}

function assertReplaceable(outputRoot) {
  if (!existsSync(outputRoot)) return;
  const marker = join(outputRoot, GENERATED_MARKER);
  if (
    !existsSync(marker) ||
    readFileSync(marker, "utf8").trim() !== MARKETPLACE_NAME
  ) {
    throw new Error(
      `refusing to replace an output not owned by this builder: ${outputRoot}`,
    );
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildReleaseMarketplace({
  outputRoot,
  target,
  commit = process.env.GITHUB_SHA ?? "local",
  offline = process.env.VIBEHUB_OFFLINE === "1",
} = {}) {
  if (!outputRoot) throw new Error("outputRoot is required");
  const identity = readReleaseIdentity(root);
  const runtimeNodeMajor = Number(process.versions.node.split(".")[0]);
  const expectedTarget = targetFor(
    process.platform,
    process.arch,
    runtimeNodeMajor,
  );
  if (target !== expectedTarget) {
    throw new Error(
      `target ${target} does not match builder runtime ${expectedTarget}`,
    );
  }
  if (runtimeNodeMajor !== RELEASE_NODE_MAJOR) {
    throw new Error(
      `public artifacts must be built with Node ${RELEASE_NODE_MAJOR}; current runtime is Node ${runtimeNodeMajor}`,
    );
  }

  const absoluteOutput = resolve(outputRoot);
  assertReplaceable(absoluteOutput);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  const stage = mkdtempSync(join(dirname(absoluteOutput), ".vibehub-release-stage-"));
  try {
    const pluginRoot = join(stage, "plugins", "vibehub");
    buildPluginArtifact({ sourceRoot: root, artifactRoot: pluginRoot, offline });

    writeJson(join(stage, ".claude-plugin", "marketplace.json"), {
      $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
      name: MARKETPLACE_NAME,
      description: "VibeHub public marketplace for Claude Code.",
      version: identity.version,
      owner: { name: "VibeHub Team" },
      plugins: [
        {
          name: identity.name,
          source: "./plugins/vibehub",
          description: identity.claudeManifest.description,
          version: identity.version,
          author: identity.claudeManifest.author,
          homepage: "https://github.com/VW-ai/vibehub-plugin",
          repository: "https://github.com/VW-ai/vibehub-plugin",
          license: identity.claudeManifest.license,
          keywords: identity.claudeManifest.keywords,
          category: "development",
        },
      ],
    });

    writeJson(join(stage, ".agents", "plugins", "marketplace.json"), {
      name: MARKETPLACE_NAME,
      interface: { displayName: "VibeHub" },
      plugins: [
        {
          name: identity.name,
          source: { source: "local", path: "./plugins/vibehub" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    });

    writeJson(join(stage, "release.json"), {
      schemaVersion: 1,
      name: identity.name,
      version: identity.version,
      target,
      platform: process.platform,
      arch: process.arch,
      node: {
        major: runtimeNodeMajor,
        abi: process.versions.modules,
        version: process.versions.node,
      },
      commit,
    });
    writeFileSync(join(stage, GENERATED_MARKER), `${MARKETPLACE_NAME}\n`);
    if (existsSync(absoluteOutput)) {
      rmSync(absoluteOutput, { recursive: true, force: true });
    }
    renameSync(stage, absoluteOutput);
    return {
      outputRoot: absoluteOutput,
      pluginRoot: join(absoluteOutput, "plugins", "vibehub"),
      version: identity.version,
      target,
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  const result = buildReleaseMarketplace({
    outputRoot: options.out,
    target: options.target,
    commit: options.commit,
    offline: options.offline,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
