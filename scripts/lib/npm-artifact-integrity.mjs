import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export function archiveIntegrity(archive) {
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

export function tarPayloadIntegrity(archive) {
  return archiveIntegrity(gunzipSync(archive));
}

export async function publishedArchiveMatches(
  localArchive,
  publishedIntegrity,
  publishedTarball,
) {
  if (publishedIntegrity === archiveIntegrity(localArchive)) {
    return true;
  }
  if (typeof publishedTarball !== "string" || publishedTarball.length === 0) {
    return false;
  }
  const response = await fetch(publishedTarball, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(
      `could not download published npm archive: HTTP ${response.status}`,
    );
  }
  const publishedArchive = Buffer.from(await response.arrayBuffer());
  if (archiveIntegrity(publishedArchive) !== publishedIntegrity) {
    throw new Error(
      "downloaded npm archive does not match its registry integrity",
    );
  }
  return (
    tarPayloadIntegrity(publishedArchive) === tarPayloadIntegrity(localArchive)
  );
}
