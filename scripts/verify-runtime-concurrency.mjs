#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readReleaseIdentity } from "./release-metadata.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const identity = readReleaseIdentity(root);
const launcher = join(root, "runtime", "vibehub-runtime.mjs");
const temp = mkdtempSync(join(tmpdir(), "vibehub-runtime-concurrency-"));
const runtimeRoot = join(temp, "runtime");
const installCount = join(temp, "install-count.txt");
const fakeNpm = join(temp, "fake-npm.mjs");

writeFileSync(
  fakeNpm,
  `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
if (!prefix) process.exit(2);
appendFileSync(process.env.VIBEHUB_TEST_INSTALL_COUNT, "install\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
const packages = [
  ["vibehub-core", "export const openDb=()=>({close(){}});\\n"],
  ["vibehub-cli", "process.stdout.write('cli-ready\\\\n');\\n"],
  ["vibehub-workbench-mcp", "process.stdout.write('mcp-ready\\\\n');\\n"],
];
for (const [name, source] of packages) {
  const packageRoot = join(prefix, "node_modules", "@vw-ai", name);
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "@vw-ai/" + name, version: ${JSON.stringify(identity.version)}, type: "module" }),
  );
  writeFileSync(
    join(packageRoot, "dist", name === "vibehub-core" ? "index.js" : name === "vibehub-cli" ? "main.js" : "stdio.js"),
    source,
  );
}
`,
);
chmodSync(fakeNpm, 0o755);

function launch(mode) {
  const child = spawn(process.execPath, [launcher, mode, "probe"], {
    cwd: temp,
    env: {
      ...process.env,
      HOME: join(temp, "home"),
      VIBEHUB_NPM_BIN: fakeNpm,
      VIBEHUB_RUNTIME_DIR: runtimeRoot,
      VIBEHUB_RUNTIME_INSTALL_TIMEOUT_MS: "5000",
      VIBEHUB_TEST_INSTALL_COUNT: installCount,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveChild, rejectChild) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectChild(new Error(`runtime concurrency probe timed out\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectChild(error);
    });
    child.once("exit", (status) => {
      clearTimeout(timeout);
      if (status !== 0) {
        rejectChild(
          new Error(
            `runtime ${mode} probe failed (${status})\n${stdout}\n${stderr}`,
          ),
        );
      } else {
        resolveChild({ mode, stdout, stderr });
      }
    });
  });
}

try {
  const results = await Promise.all([launch("cli"), launch("mcp")]);
  const installs = existsSync(installCount)
    ? readFileSync(installCount, "utf8").trim().split(/\r?\n/).filter(Boolean)
    : [];
  if (installs.length !== 1) {
    throw new Error(
      `concurrent runtime launch performed ${installs.length} npm installs`,
    );
  }
  if (results.some((result) => !result.stdout.includes(`${result.mode}-ready`))) {
    throw new Error("both runtime consumers did not start from the shared cache");
  }
  if (existsSync(`${runtimeRoot}.installing`)) {
    throw new Error("runtime installer left its coordination lock behind");
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version: identity.version,
      consumers: ["cli", "mcp"],
      installs: 1,
    })}\n`,
  );
} finally {
  if (process.env.VIBEHUB_KEEP_TMP === "1") {
    process.stderr.write(`kept runtime concurrency probe at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
