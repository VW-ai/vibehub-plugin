#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import boundaries from "../../docs/proposals/harness-neutral-core/package-boundaries.json" with { type: "json" };

const repoRoot = resolve(new URL("../../", import.meta.url).pathname);
const sourceExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);

async function filesUnder(root) {
  const result = [];
  const walk = async (path) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const target = join(path, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (sourceExtensions.has(extname(entry.name)) || entry.name === "package.json") result.push(target);
    }
  };
  await walk(resolve(repoRoot, root));
  return result;
}

function importedPackages(text) {
  const result = [];
  for (const match of text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/gu)) {
    if (!match[1].startsWith(".") && !match[1].startsWith("node:")) result.push(match[1]);
  }
  return result;
}

export async function probeDomainIsolation(domain) {
  const files = (await Promise.all(domain.roots.map(filesUnder))).flat();
  const violations = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const packages = file.endsWith("package.json")
      ? Object.keys({
          ...JSON.parse(text).dependencies,
          ...JSON.parse(text).optionalDependencies,
          ...JSON.parse(text).peerDependencies,
        })
      : importedPackages(text);
    for (const packageName of packages) {
      const prefix = domain.forbiddenPackagePrefixes.find((value) => packageName === value || packageName.startsWith(`${value}/`));
      if (prefix) violations.push({ file: file.slice(repoRoot.length + 1), packageName, forbiddenPrefix: prefix });
    }
  }
  return { domain: domain.id, files: files.length, proven: violations.length === 0, violations };
}

export async function probePackageIsolation() {
  const checks = [];
  for (const domain of boundaries.domains) checks.push(await probeDomainIsolation(domain));
  return { ok: checks.every((check) => check.proven), schemaVersion: boundaries.schemaVersion, checks };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = await probePackageIsolation();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
