#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const siteRoot = join(repoRoot, "site");
const canonicalUrl = "https://vibehub.team";
const redirectHosts = ["www.vibehub.team", "vibehub.icu", "www.vibehub.icu", "vibehub.systems", "www.vibehub.systems"];
const cloudflareAccountId = "72091e7e079e357ced7f9603c03a926e";
const pagesProjectName = "vibehub-website-v1";
const productionBranch = "main";
const title = "VibeHub — The Git-native development cycle";
const productMarker = "Stop managing chats. Manage the work.";

function assertion(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(relativePath) {
  return readFile(join(repoRoot, relativePath), "utf8");
}

async function exists(relativePath) {
  try {
    await access(join(repoRoot, relativePath));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  assertion(result.status === 0, `${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  return result;
}

async function checkConfiguration() {
  const [packageSource, layoutSource, robotsSource, sitemapSource, viteSource, skillSource] = await Promise.all([
    readText("site/package.json"),
    readText("site/app/layout.tsx"),
    readText("site/public/robots.txt"),
    readText("site/public/sitemap.xml"),
    readText("site/vite.config.ts"),
    readText("site/release/SKILL.md"),
  ]);
  const packageJson = JSON.parse(packageSource);

  assertion(!(await exists("site/.openai/hosting.json")), "Obsolete Sites hosting metadata must not exist");
  assertion(!(await exists("site/build/sites-vite-plugin.ts")), "Obsolete Sites build plugin must not exist");
  assertion(packageJson.name === "@vibehub/site", "Expected the VibeHub public-site package");
  assertion(packageJson.scripts?.["release:deploy"]?.includes("release.mjs deploy"), "Expected the Cloudflare Pages deploy entry point");
  assertion(!viteSource.includes("sites-vite-plugin"), "Vite must not package Sites metadata");
  assertion(skillSource.includes(pagesProjectName), `Release Skill must name existing Pages project ${pagesProjectName}`);
  assertion(!skillSource.includes("Sites hosting Skill"), "Release Skill must not retain the obsolete Sites publisher");
  assertion(layoutSource.includes("NEXT_PUBLIC_SITE_URL"), "Site metadata must use NEXT_PUBLIC_SITE_URL");
  assertion(layoutSource.includes('canonical: "/"'), "Site metadata must publish the canonical apex URL");
  assertion(layoutSource.includes(title), "Site metadata title changed; update the release contract deliberately");
  assertion(layoutSource.includes('url: "/og.png"'), "Site metadata must publish the checked-in Open Graph image");
  assertion(robotsSource.includes("User-agent: *"), "robots.txt must allow public crawler rules");
  assertion(robotsSource.includes(`Sitemap: ${canonicalUrl}/sitemap.xml`), "robots.txt must name the canonical sitemap");
  assertion(sitemapSource.includes(`<loc>${canonicalUrl}/</loc>`), "sitemap.xml must name the canonical homepage");
  for (const host of redirectHosts) {
    assertion(!sitemapSource.includes(host), `sitemap.xml must not publish the redirect-only hostname ${host}`);
  }

  return {
    cloudflare_account_id: cloudflareAccountId,
    pages_project_name: pagesProjectName,
    production_branch: productionBranch,
    canonical_url: canonicalUrl,
  };
}

function runNpm(script, env = {}) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  run(npm, ["run", script], { cwd: siteRoot, env });
}

async function preflight() {
  const configuration = await checkConfiguration();
  runNpm("lint");
  runNpm("test", { NEXT_PUBLIC_SITE_URL: canonicalUrl });
  return configuration;
}

function git(...args) {
  return run("git", args, { capture: true }).stdout.trim();
}

async function deploy() {
  const configuration = await checkConfiguration();
  for (const artifact of [
    "site/dist/client/index.html",
    "site/dist/client/robots.txt",
    "site/dist/client/sitemap.xml",
    "site/dist/client/og.png",
  ]) {
    assertion(await exists(artifact), `Missing deployable artifact ${artifact}; run release:preflight first`);
  }

  assertion(git("status", "--porcelain") === "", "Deploy only a clean, exact committed source state");
  const commitHash = git("rev-parse", "HEAD");
  assertion(/^[0-9a-f]{40}$/.test(commitHash), "Expected a full 40-character Git commit hash");
  const commitMessage = git("log", "-1", "--pretty=%s");
  const wrangler = join(siteRoot, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  assertion(await exists("site/node_modules/.bin/wrangler"), "Wrangler is not installed; run npm ci in site/");

  const result = run(wrangler, [
    "pages",
    "deploy",
    "dist/client",
    "--project-name",
    pagesProjectName,
    "--branch",
    productionBranch,
    "--commit-hash",
    commitHash,
    "--commit-message",
    commitMessage,
  ], {
    cwd: siteRoot,
    capture: true,
    env: {
      CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
      WRANGLER_LOG_PATH: join(siteRoot, ".wrangler", "wrangler.log"),
    },
  });
  process.stderr.write(result.stderr ?? "");
  process.stderr.write(result.stdout ?? "");
  const deploymentUrl = result.stdout.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev/i)?.[0] ?? null;
  assertion(deploymentUrl, "Wrangler completed without returning an immutable Pages deployment URL");

  return { ...configuration, commit_hash: commitHash, deployment_url: deploymentUrl };
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

  const [robotsResponse, sitemapResponse, ogResponse, faviconResponse] = await Promise.all([
    fetch(new URL("/robots.txt", url), { signal: AbortSignal.timeout(20_000) }),
    fetch(new URL("/sitemap.xml", url), { signal: AbortSignal.timeout(20_000) }),
    fetch(new URL("/og.png", url), { signal: AbortSignal.timeout(20_000) }),
    fetch(new URL("/vibehub-favicon.svg", url), { signal: AbortSignal.timeout(20_000) }),
  ]);
  assertion(robotsResponse.ok, `Expected robots.txt, received HTTP ${robotsResponse.status}`);
  assertion(sitemapResponse.ok, `Expected sitemap.xml, received HTTP ${sitemapResponse.status}`);
  assertion(ogResponse.ok, `Expected og.png, received HTTP ${ogResponse.status}`);
  assertion(faviconResponse.ok, `Expected vibehub-favicon.svg, received HTTP ${faviconResponse.status}`);
  const [robots, sitemap] = await Promise.all([robotsResponse.text(), sitemapResponse.text()]);
  assertion(robots.includes(`Sitemap: ${canonicalUrl}/sitemap.xml`), "robots.txt does not name the canonical sitemap");
  assertion(sitemap.includes(`<loc>${canonicalUrl}/</loc>`), "sitemap.xml does not name the canonical homepage");
  for (const host of redirectHosts) {
    assertion(!sitemap.includes(host), `sitemap.xml must not publish the redirect-only hostname ${host}`);
  }

  return {
    requested_url: url.href,
    final_url: response.url,
    status: response.status,
    robots_status: robotsResponse.status,
    sitemap_status: sitemapResponse.status,
    og_status: ogResponse.status,
    favicon_status: faviconResponse.status,
  };
}

async function verifyRedirects() {
  const pathAndQuery = "/domain-discovery-check?source=vibehub";
  const expected = `${canonicalUrl}${pathAndQuery}`;
  const checks = [];

  for (const host of redirectHosts) for (const protocol of ["http:", "https:"]) {
    const requested = `${protocol}//${host}${pathAndQuery}`;
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
  if (command === "deploy") {
    assertion(args.length === 0, "deploy does not accept arguments");
    const result = await deploy();
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  if (command === "verify") {
    const result = await verify(args[0]);
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  if (command === "verify-redirects") {
    assertion(args.length === 0, "verify-redirects does not accept a URL argument");
    const result = await verifyRedirects();
    process.stdout.write(`${JSON.stringify({ ok: true, command, ...result })}\n`);
    return;
  }
  throw new Error("Usage: release.mjs <check|preflight|deploy|verify|verify-redirects> [https-url]");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
