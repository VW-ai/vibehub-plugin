#!/usr/bin/env node
import {
  accessSync,
  constants,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const repositoryUrl = "https://github.com/VW-ai/vibehub-plugin.git";
const packages = [
  {
    directory: "packages/core",
    expectedName: "@vw-ai/vibehub-core",
    expectedBin: null,
  },
  {
    directory: "packages/cli",
    expectedName: "@vw-ai/vibehub-cli",
    expectedBin: "vibehub",
  },
  {
    directory: "packages/mcp",
    expectedName: "@vw-ai/vibehub-workbench-mcp",
    expectedBin: "vibehub-mcp",
  },
];
const retiredCoreArtifactPrefixes = [
  "dist/git-ticket-store.",
  "dist/ticket-proposal-service.",
  "dist/ticket-application-service.",
  "dist/contract/ticket-proposal",
  "dist/contract/ticket-application",
];

function listFiles(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory()
      ? listFiles(join(directory, entry.name), relativePath)
      : entry.isFile()
        ? [relativePath]
        : [];
  });
}

for (const entry of packages) {
  const packageRoot = join(root, entry.directory);
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );

  if (manifest.name !== entry.expectedName) {
    throw new Error(
      `${entry.directory} must publish as ${entry.expectedName}; got ${manifest.name}`,
    );
  }
  if (manifest.version !== identity.version) {
    throw new Error(
      `${manifest.name} version ${manifest.version} must equal release version ${identity.version}`,
    );
  }
  if (
    manifest.repository?.url !== repositoryUrl ||
    manifest.repository?.directory !== entry.directory
  ) {
    throw new Error(
      `${manifest.name} repository must point to ${repositoryUrl} at ${entry.directory}`,
    );
  }
  if (manifest.publishConfig?.access !== "public") {
    throw new Error(`${manifest.name} must publish with public access`);
  }
  if (manifest.engines?.node !== ">=20") {
    throw new Error(`${manifest.name} must declare Node.js >=20`);
  }
  if (!manifest.files?.includes("dist")) {
    throw new Error(`${manifest.name} must publish only its built dist surface`);
  }

  if (entry.expectedName === "@vw-ai/vibehub-core") {
    const builtArtifacts = listFiles(join(packageRoot, "dist"))
      .map((artifact) => `dist/${artifact}`);
    const retiredArtifact = builtArtifacts.find((artifact) =>
      retiredCoreArtifactPrefixes.some((prefix) =>
        artifact.startsWith(prefix)));
    if (retiredArtifact) {
      throw new Error(
        `@vw-ai/vibehub-core dist contains retired Ticket backend artifact ${retiredArtifact}`,
      );
    }
  }

  accessSync(join(packageRoot, "README.md"), constants.R_OK);

  if (entry.expectedBin) {
    const binPath = manifest.bin?.[entry.expectedBin];
    if (!binPath) {
      throw new Error(
        `${manifest.name} must expose the ${entry.expectedBin} executable`,
      );
    }
    accessSync(join(packageRoot, binPath), constants.R_OK);
  }
}

if (identity.cliPackage.dependencies?.["@vw-ai/vibehub-core"] !== "workspace:*") {
  throw new Error("@vw-ai/vibehub-cli must depend on workspace:* @vw-ai/vibehub-core");
}
if (identity.mcpPackage.dependencies?.["@vw-ai/vibehub-core"] !== "workspace:*") {
  throw new Error(
    "@vw-ai/vibehub-workbench-mcp must depend on workspace:* @vw-ai/vibehub-core",
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version: identity.version,
    packages: packages.map((entry) => entry.expectedName),
  })}\n`,
);
