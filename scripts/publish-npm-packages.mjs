#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(root, "dist", "npm");
const manifest = JSON.parse(
  readFileSync(join(artifactRoot, "manifest.json"), "utf8"),
);
const releaseTag = process.env.VIBEHUB_NPM_RELEASE_TAG;

function sha512(buffer) {
  return createHash("sha512").update(buffer).digest("base64");
}

function tarPayloadIntegrity(archive) {
  return `sha512-${sha512(gunzipSync(archive))}`;
}

if (releaseTag !== manifest.tag) {
  throw new Error(
    `VIBEHUB_NPM_RELEASE_TAG must equal ${manifest.tag}; got ${releaseTag ?? "<unset>"}`,
  );
}

const tagCommit = spawnSync(
  "git",
  ["rev-parse", "--verify", `${releaseTag}^{commit}`],
  { cwd: root, encoding: "utf8" },
);
const headCommit = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
if (
  tagCommit.status !== 0 ||
  headCommit.status !== 0 ||
  tagCommit.stdout.trim() !== headCommit.stdout.trim()
) {
  throw new Error(
    `${releaseTag} must exist locally and point to the current commit before npm publication`,
  );
}

for (const entry of manifest.packages) {
  const spec = `${entry.name}@${entry.version}`;
  const lookup = spawnSync("npm", ["view", spec, "version", "--json"], {
    cwd: root,
    encoding: "utf8",
  });

  if (lookup.status === 0) {
    const publishedVersion = JSON.parse(lookup.stdout);
    const archivePath = join(artifactRoot, entry.archive);
    const localArchive = readFileSync(archivePath);
    const localIntegrity = `sha512-${sha512(localArchive)}`;
    const integrityLookup = spawnSync(
      "npm",
      ["view", spec, "dist.integrity", "dist.tarball", "--json"],
      { cwd: root, encoding: "utf8" },
    );
    const publishedDist =
      integrityLookup.status === 0 ? JSON.parse(integrityLookup.stdout) : null;
    let contentMatches = publishedDist?.["dist.integrity"] === localIntegrity;

    if (!contentMatches && publishedDist?.["dist.tarball"]) {
      const response = await fetch(publishedDist["dist.tarball"]);
      if (!response.ok) {
        throw new Error(
          `could not download ${spec} for content verification: HTTP ${response.status}`,
        );
      }
      const publishedArchive = Buffer.from(await response.arrayBuffer());
      contentMatches =
        tarPayloadIntegrity(publishedArchive) ===
        tarPayloadIntegrity(localArchive);
    }

    if (publishedVersion !== entry.version || !contentMatches) {
      throw new Error(
        `${spec} already exists but does not match the local release contents`,
      );
    }
    process.stdout.write(`already published: ${spec}\n`);
    continue;
  }

  const lookupOutput = `${lookup.stdout}\n${lookup.stderr}`;
  if (!lookupOutput.includes("E404")) {
    throw new Error(`could not check ${spec}:\n${lookupOutput}`);
  }

  const publish = spawnSync(
    "npm",
    ["publish", join(artifactRoot, entry.archive), "--access", "public"],
    { cwd: root, encoding: "utf8", stdio: "inherit" },
  );
  if (publish.status !== 0) {
    throw new Error(`failed to publish ${spec}`);
  }
}
