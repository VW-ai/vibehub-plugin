#!/usr/bin/env node
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";

const paths = process.argv.slice(2).map((entry) => resolve(entry));
if (paths.length !== 4) {
  throw new Error(
    "usage: verify-github-release-assets.mjs <expected-archive> <expected-checksum> <published-archive> <published-checksum>",
  );
}

const [
  expectedArchive,
  expectedChecksum,
  publishedArchive,
  publishedChecksum,
] = paths;

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function declaredChecksum(file, archive) {
  const line = readFileSync(file, "utf8").trim();
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
  if (!match) {
    throw new Error(`invalid SHA-256 receipt: ${file}`);
  }
  if (basename(match[2]) !== basename(archive)) {
    throw new Error(
      `${file} names ${match[2]} instead of ${basename(archive)}`,
    );
  }
  return match[1];
}

const expectedDigest = sha256(expectedArchive);
const publishedDigest = sha256(publishedArchive);
if (declaredChecksum(expectedChecksum, expectedArchive) !== expectedDigest) {
  throw new Error("locally generated GitHub Release checksum is invalid");
}
if (declaredChecksum(publishedChecksum, publishedArchive) !== publishedDigest) {
  throw new Error("published GitHub Release checksum is invalid");
}
if (publishedDigest !== expectedDigest) {
  throw new Error(
    `published GitHub Release archive differs from this tag: expected ${expectedDigest}, got ${publishedDigest}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    archive: basename(expectedArchive),
    sha256: expectedDigest,
  })}\n`,
);
