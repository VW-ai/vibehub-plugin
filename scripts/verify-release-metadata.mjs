#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readReleaseIdentity,
  RELEASE_NODE_MAJOR,
  RELEASE_TARGETS,
} from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const suppliedTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? null;

if (suppliedTag && suppliedTag !== `v${identity.version}`) {
  throw new Error(
    `release tag ${suppliedTag} must equal manifest version v${identity.version}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    name: identity.name,
    version: identity.version,
    tag: `v${identity.version}`,
    nodeMajor: RELEASE_NODE_MAJOR,
    targets: RELEASE_TARGETS,
  })}\n`,
);
