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
  const [hostingSource, packageSource, layoutSource, robotsSource, sitemapSource] = await Promise.all([
    readText("site/.openai/hosting.json"),
    readText("site/package.json"),
    readText("site/app/layout.tsx"),
    readText("site/public/robots.txt"),
    readText("site/public/sitemap.xml"),
  ]);
  const hosting = JSON.parse(hostingSource);
  const packageJson = JSON.parse(packageSource);

  assertion(hosting.project_id === projectId, `Expected existing Sites project ${projectId}`);
  assertion(hosting.d1 === null && hosting.r2 === null, "Public site must not add D1 or R2 bindings");
  assertion(packageJson.name === "@vibehub/site", "Expected the VibeHub public-site package");
  assertion(layoutSource.includes("NEXT_PUBLIC_SITE_URL"), "Site metadata must use NEXT_PUBLIC_SITE_URL");
  assertion(layoutSource.includes('canonical: "/"'), "Site metadata must publish the canonical apex URL");
  assertion(layoutSource.includes(title), "Site metadata title changed; update the release contract deliberately");
  assertion(layoutSource.includes('url: "/og.png"'), "Site metadata must publish the checked-in Open Graph image");
  assertion(robotsSource.includes("User-agent: *"), "robots.txt must allow public crawler rules");
  assertion(robotsSource.includes(`Sitemap: ${canonicalUrl}/sitemap.xml`), "robots.txt must name the canonical sitemap");
  assertion(sitemapSource.includes(`<loc>${canonicalUrl}/</loc>`), "sitemap.xml must name the canonical homepage");

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
  assertion(html.includes(`rel="canonical" href="${canonicalUrl}/"`), "Production page is missing the canonical apex link");

  const [robotsResponse, sitemapResponse] = await Promise.all([
    fetch(new URL("/robots.txt", url), { signal: AbortSignal.timeout(20_000) }),
    fetch(new URL("/sitemap.xml", url), { signal: AbortSignal.timeout(20_000) }),
  ]);
  assertion(robotsResponse.ok, `Expected robots.txt, received HTTP ${robotsResponse.status}`);
  assertion(sitemapResponse.ok, `Expected sitemap.xml, received HTTP ${sitemapResponse.status}`);
  const [robots, sitemap] = await Promise.all([robotsResponse.text(), sitemapResponse.text()]);
  assertion(robots.includes(`Sitemap: ${canonicalUrl}/sitemap.xml`), "robots.txt does not name the canonical sitemap");
  assertion(sitemap.includes(`<loc>${canonicalUrl}/</loc>`), "sitemap.xml does not name the canonical homepage");
  assertion(!sitemap.includes("www.vibehub.icu"), "sitemap.xml must not publish the redirect-only www hostname");

  return {
    requested_url: url.href,
    final_url: response.url,
    status: response.status,
    robots_status: robotsResponse.status,
    sitemap_status: sitemapResponse.status,
  };
}

async function verifyWww() {
  const pathAndQuery = "/domain-discovery-check?source=vibehub";
  const expected = `${canonicalUrl}${pathAndQuery}`;
  const checks = [];

  for (const protocol of ["http:", "https:"]) {
    const requested = `${protocol}//www.vibehub.icu${pathAndQuery}`;
    const response = await fetch(requested, {
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "VibeHub release verifier" },
    });
    const location = response.headers.get("location");
    assertion([301, 308].includes(response.status), `Expected a permanent redirect from ${requested}, received HTTP ${response.status}`);
    assertion(location !== null, `Expected a Location header from ${requested}`);
    assertion(new URL(location, requested).href === expected, `Expected ${requested} to preserve its path and query at ${expected}`);
    checks.push({ requested_url: requested, status: response.status, location });
  }

  return { canonical_url: canonicalUrl, checks };
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
  if (command === "verify-www") {
    assertion(args.length === 0, "verify-www does not accept a URL argument");
    const result = await verifyWww();
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  throw new Error("Usage: release.mjs <check|preflight|verify|verify-www> [https-url]");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
