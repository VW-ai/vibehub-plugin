import { build } from "vite";
import { rm } from "node:fs/promises";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const probeOutDir = "dist-boundary-probe";

const fixtureProbe = {
  name: "fixture-boundary-probe",
  enforce: "pre",
  transform(code, id) {
    if (!id.endsWith("/src/main.tsx")) return null;
    return `${code}\nvoid import("/test/fixtures/v8-baseline.ts");`;
  },
};

let rejected = false;
try {
  await build({
    mode: "production",
    logLevel: "silent",
    plugins: [fixtureProbe],
    build: { outDir: probeOutDir, emptyOutDir: true },
  });
} catch (error) {
  rejected = String(error).includes("production entry imports test fixtures");
}

if (!rejected) {
  await rm(probeOutDir, { recursive: true, force: true });
  throw new Error("production boundary accepted a dynamic test fixture chunk");
}

await rm(probeOutDir, { recursive: true, force: true });
await build({ mode: "production", logLevel: "silent" });

async function emittedFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await emittedFiles(path)));
    else if (/\.(?:js|css|html|json)$/.test(entry.name)) output.push(path);
  }
  return output;
}

const forbidden =
  /(?:test\/fixtures|app-demo|live-fixture|v8-baseline|fixture=live|\bcanned\b|\bdummy data\b|\bmockData\b)/i;
for (const file of await emittedFiles("dist")) {
  if (forbidden.test(await readFile(file, "utf8"))) {
    throw new Error(`production bundle contains a fixture/canned-data marker: ${file}`);
  }
}
console.log("production boundary: fixtures rejected; emitted bundle has no fixture/canned markers");
