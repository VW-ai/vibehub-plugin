#!/usr/bin/env node
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifactRoot = join(root, "dist", "npm");
const manifest = JSON.parse(
  readFileSync(join(artifactRoot, "manifest.json"), "utf8"),
);
const installRoot = mkdtempSync(join(tmpdir(), "vibehub-npm-install-"));
const npmEnv = {
  ...process.env,
  NPM_CONFIG_CACHE: join(installRoot, "npm-cache"),
};

try {
  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );
  const install = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      ...manifest.packages.map((entry) =>
        join(artifactRoot, entry.archive),
      ),
    ],
    { cwd: installRoot, env: npmEnv, encoding: "utf8", stdio: "inherit" },
  );
  if (install.status !== 0) {
    throw new Error("isolated npm tarball installation failed");
  }

  const audit = spawnSync(
    "npm",
    ["audit", "--prefix", installRoot, "--omit=dev", "--audit-level=moderate"],
    { cwd: installRoot, env: npmEnv, encoding: "utf8", stdio: "inherit" },
  );
  if (audit.status !== 0) {
    throw new Error("the published production dependency tree failed npm audit");
  }

  const cli = join(installRoot, "node_modules", ".bin", "vibehub");
  const cliHelp = spawnSync(cli, ["--help"], {
    cwd: installRoot,
    encoding: "utf8",
  });
  if (
    cliHelp.status !== 2 ||
    !cliHelp.stderr.includes("vibehub doctor")
  ) {
    throw new Error("the installed vibehub executable did not start");
  }

  const mcp = join(installRoot, "node_modules", ".bin", "vibehub-mcp");
  const core = join(
    installRoot,
    "node_modules",
    "@vw-ai",
    "core",
    "dist",
    "index.js",
  );
  const runtime = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "const m = await import(process.argv[1]);",
        "if (typeof m.openDb !== 'function') throw new Error('openDb missing');",
        "const db = m.openDb(':memory:');",
        "db.close();",
      ].join(" "),
      core,
    ],
    { cwd: installRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (runtime.status !== 0) {
    throw new Error("the installed native SQLite runtime did not load");
  }

  const mcpProbe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "import { accessSync, constants } from 'node:fs';",
        "accessSync(process.argv[1], constants.X_OK);",
      ].join(" "),
      mcp,
    ],
    { cwd: installRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (mcpProbe.status !== 0) {
    throw new Error("the installed vibehub-mcp executable is missing");
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: manifest.version,
      packages: manifest.packages.map((entry) => entry.name),
    })}\n`,
  );
} finally {
  rmSync(installRoot, { recursive: true, force: true });
}
