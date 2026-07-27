#!/usr/bin/env node
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts", "src/stdio.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@vibehub/core"],
  sourcemap: false,
  legalComments: "none",
});
