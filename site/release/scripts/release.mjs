#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const siteRoot = join(repoRoot, "site");
const canonicalUrl = "https://vibehub.icu";
const projectId = "appgprj_6a86aafc71d48191b3c03a532dc367f3";
const title = "VibeHub — The Git-native development cycle";
const productMarker = "Stop managing chats. Manage the work.";

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

async function checkConfiguration() {
  const [hostingSource, packageSource, layoutSource] = await Promise.all([
    readText("site/.openai/hosting.json"),
    readText("site/package.json"),
    readText("site/app/layout.tsx"),
  ]);
  const hosting = JSON.parse(hostingSource);
  const packageJson = JSON.parse(packageSource);

  assertion(hosting.project_id === projectId, `Expected existing Sites project ${projectId}`);
  assertion(hosting.d1 === null && hosting.r2 === null, "Public site must not add D1 or R2 bindings");
  assertion(packageJson.name === "@vibehub/site", "Expected the VibeHub public-site package");
  assertion(layoutSource.includes("NEXT_PUBLIC_SITE_URL"), "Site metadata must use NEXT_PUBLIC_SITE_URL");
  assertion(layoutSource.includes(title), "Site metadata title changed; update the release contract deliberately");
  assertion(layoutSource.includes('url: "/og.png"'), "Site metadata must publish the checked-in Open Graph image");

  return { project_id: hosting.project_id, canonical_url: canonicalUrl };
}

function runNpm(script, env = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["run", script], {
    cwd: siteRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "inherit",
  });
  assertion(result.status === 0, `npm run ${script} failed with exit code ${result.status ?? "unknown"}`);
}

async function preflight() {
  const configuration = await checkConfiguration();
  runNpm("lint");
  runNpm("test", { NEXT_PUBLIC_SITE_URL: canonicalUrl });
  return configuration;
}

async function verify(target = canonicalUrl) {
  const url = new URL(target);
  assertion(url.protocol === "https:", "Release verification requires an HTTPS URL");

  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": "VibeHub release verifier" },
  });
  assertion(response.ok, `Expected a successful response from ${url}, received HTTP ${response.status}`);
  assertion(response.url.startsWith("https://"), `Expected the final response to remain on HTTPS, received ${response.url}`);

  const html = await response.text();
  assertion(html.includes(`<title>${title}</title>`), "Production title does not match the release contract");
  assertion(html.includes(productMarker), "Production page is missing the stable VibeHub product marker");
  assertion(html.includes(`content="${canonicalUrl}/og.png"`), "Production metadata does not point to the canonical Open Graph image");

  return { requested_url: url.href, final_url: response.url, status: response.status };
}

async function main() {
  const [command = "check", ...args] = process.argv.slice(2);
  assertion(args.length <= 1, "Expected at most one URL argument");

  if (command === "check") {
    const result = await checkConfiguration();
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  if (command === "preflight") {
    const result = await preflight();
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verify(args[0]);
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  throw new Error("Usage: release.mjs <check|preflight|verify> [https-url]");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
