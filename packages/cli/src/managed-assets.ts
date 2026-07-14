import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256, type ManagedAssetManifest } from "@vibehub/core";

const RELEASE_VERSION = "0.1.0";
function releaseFiles(root: string, relative = ""): string[] {
  const current = path.join(root, relative);
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? releaseFiles(root, child) : [child];
  });
}

/** Build output contains a pristine release copy used to repair this allowlist. */
export function releaseAssetManifest(): ManagedAssetManifest {
  const cliDist = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = process.env["VIBEHUB_PLUGIN_ROOT"]
    ? path.resolve(process.env["VIBEHUB_PLUGIN_ROOT"]!)
    : path.resolve(cliDist, "../../..");
  const sourceRoot = process.env["VIBEHUB_ASSET_SOURCE"]
    ? path.resolve(process.env["VIBEHUB_ASSET_SOURCE"]!)
    : path.join(cliDist, "managed-assets");
  return {
    schemaVersion: 1,
    releaseVersion: RELEASE_VERSION,
    // Discover the immutable release tree rather than naming SKILL.md only:
    // future shared references and deterministic scripts are automatically
    // covered by the same ownership/checksum/repair contract.
    assets: releaseFiles(sourceRoot).map((relative) => {
      const content = fs.readFileSync(path.join(sourceRoot, relative), "utf8");
      return {
        source: `release://${RELEASE_VERSION}/${relative}`,
        target: path.join(pluginRoot, relative),
        content,
        checksum: sha256(content),
        version: RELEASE_VERSION,
        repairPolicy: "replace-managed" as const,
      };
    }),
  };
}

export function releaseAssetRoot(): string {
  const cliDist = path.dirname(fileURLToPath(import.meta.url));
  return process.env["VIBEHUB_PLUGIN_ROOT"]
    ? path.resolve(process.env["VIBEHUB_PLUGIN_ROOT"]!)
    : path.resolve(cliDist, "../../..");
}
