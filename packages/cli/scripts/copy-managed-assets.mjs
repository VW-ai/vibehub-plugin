import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.resolve(packageRoot, "../..");
const outputRoot = path.join(packageRoot, "dist", "managed-assets");
const assets = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "hooks/hooks.json",
  // Skills are one managed recursive release tree. This intentionally includes
  // shared progressive references, schemas and deterministic CLI wrappers.
  "skills",
];

fs.rmSync(outputRoot, { recursive: true, force: true });
for (const relative of assets) {
  const target = path.join(outputRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(pluginRoot, relative), target, { recursive: true });
}
