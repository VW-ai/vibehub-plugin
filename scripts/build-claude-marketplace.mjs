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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED_MARKER = ".vibehub-claude-marketplace";
const MARKETPLACE_NAME = "vibehub-local";

function parseCli(argv) {
  let out = join(root, "dist", "claude-marketplace");
  let offline = process.env.VIBEHUB_OFFLINE === "1";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") out = argv[++index] ?? "";
    else if (arg === "--offline") offline = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out) throw new Error("--out requires a path");
  return { out: resolve(out), offline };
}

function assertReplaceable(outputRoot) {
  if (!existsSync(outputRoot)) return;
  const marker = join(outputRoot, GENERATED_MARKER);
  if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== MARKETPLACE_NAME) {
    throw new Error(
      `refusing to replace an output not owned by this builder: ${outputRoot}`,
    );
  }
}

export function buildClaudeMarketplace({
  outputRoot,
  offline = process.env.VIBEHUB_OFFLINE === "1",
} = {}) {
  if (!outputRoot) throw new Error("outputRoot is required");
  const absoluteOutput = resolve(outputRoot);
  assertReplaceable(absoluteOutput);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  const stage = mkdtempSync(
    join(dirname(absoluteOutput), ".vibehub-claude-stage-"),
  );
  try {
    const pluginRoot = join(stage, "plugins", "vibehub");
    buildPluginArtifact({ sourceRoot: root, artifactRoot: pluginRoot, offline });
    const pluginManifest = JSON.parse(
      readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
    );
    const marketplacePath = join(stage, ".claude-plugin", "marketplace.json");
    mkdirSync(dirname(marketplacePath), { recursive: true });
    writeFileSync(
      marketplacePath,
      `${JSON.stringify(
        {
          $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
          name: MARKETPLACE_NAME,
          description:
            "Local VibeHub release artifact for Claude Code installation.",
          owner: { name: "VibeHub Team" },
          plugins: [
            {
              name: pluginManifest.name,
              source: "./plugins/vibehub",
              description: pluginManifest.description,
              version: pluginManifest.version,
              author: pluginManifest.author,
              homepage: "https://github.com/VW-ai/vibehub-plugin",
              repository: "https://github.com/VW-ai/vibehub-plugin",
              license: pluginManifest.license,
              keywords: pluginManifest.keywords,
              category: "development",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(stage, GENERATED_MARKER), `${MARKETPLACE_NAME}\n`);
    if (existsSync(absoluteOutput)) {
      rmSync(absoluteOutput, { recursive: true, force: true });
    }
    renameSync(stage, absoluteOutput);
    return {
      outputRoot: absoluteOutput,
      marketplacePath: join(
        absoluteOutput,
        ".claude-plugin",
        "marketplace.json",
      ),
      pluginRoot: join(absoluteOutput, "plugins", "vibehub"),
      marketplaceName: MARKETPLACE_NAME,
    };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCli(process.argv.slice(2));
  const result = buildClaudeMarketplace({
    outputRoot: options.out,
    offline: options.offline,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
