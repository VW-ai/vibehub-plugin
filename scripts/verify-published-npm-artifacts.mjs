#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishedArchiveMatches } from "./lib/npm-artifact-integrity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = resolve(process.argv[2] ?? join(root, "dist", "npm"));
const suppliedTag = process.argv[3] ?? process.env.GITHUB_REF_NAME;
const manifest = JSON.parse(
  readFileSync(join(artifactRoot, "manifest.json"), "utf8"),
);

if (suppliedTag !== manifest.tag) {
  throw new Error(
    `expected npm artifact tag ${manifest.tag}; got ${suppliedTag ?? "<unset>"}`,
  );
}

const verified = [];
for (const entry of manifest.packages) {
  const spec = `${entry.name}@${entry.version}`;
  const lookup = spawnSync(
    "npm",
    ["view", spec, "version", "dist.integrity", "dist.tarball", "--json"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  if (lookup.error) throw lookup.error;
  if (lookup.status !== 0) {
    throw new Error(
      `could not inspect ${spec}\n${lookup.stdout}\n${lookup.stderr}`,
    );
  }
  const published = JSON.parse(lookup.stdout);
  if (published.version !== entry.version) {
    throw new Error(
      `${spec} resolved to unexpected version ${published.version ?? "<missing>"}`,
    );
  }
  const localArchive = readFileSync(join(artifactRoot, entry.archive));
  const matches = await publishedArchiveMatches(
    localArchive,
    published["dist.integrity"],
    published["dist.tarball"],
  );
  if (!matches) {
    throw new Error(
      `${spec} exists on npm but does not match ${entry.archive}`,
    );
  }
  verified.push(spec);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    tag: manifest.tag,
    artifacts: verified,
  })}\n`,
);
