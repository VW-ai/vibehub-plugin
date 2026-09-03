#!/usr/bin/env node
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { UPGRADE_CONTRACT_PATHS } from "./vibehub-upgrade.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = UPGRADE_CONTRACT_PATHS.map((path) => path.slice("vibehub-core/contracts/".length));
const RELEASE_FILES = [
  ["scripts/vibehub-upgrade.mjs", "bin/vibehub-upgrade.mjs"],
  ["skills/vibehub-core/scripts/vh.mjs", "vibehub-core/scripts/vh.mjs"],
  ...CONTRACTS.map((name) => [
    `skills/vibehub-core/contracts/${name}`,
    `vibehub-core/contracts/${name}`,
  ]),
  ["skills/vibehub-migrate/references/migrations.json", "vibehub-migrate/references/migrations.json"],
];

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function writeOctal(buffer, offset, length, value) {
  const source = Math.max(0, value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(source, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarHeader(path, size, mode) {
  if (Buffer.byteLength(path) > 100) throw new Error(`tar path is too long: ${path}`);
  const header = Buffer.alloc(512, 0);
  header.write(path, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  writeOctal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
  return header;
}

function packageFiles(packageRoot) {
  const pending = [packageRoot];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error(`upgrade package contains a non-file: ${child}`);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function tarBytes(packageRoot) {
  const chunks = [];
  for (const path of packageFiles(packageRoot)) {
    const bytes = readFileSync(path);
    const archivePath = `package/${relative(packageRoot, path).split(sep).join("/")}`;
    const mode = lstatSync(path).mode & 0o111 ? 0o755 : 0o644;
    chunks.push(tarHeader(archivePath, bytes.length, mode), bytes);
    const padding = (512 - (bytes.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

function assertReleaseInputs(sourceRoot, tag, commit) {
  const packageJson = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  if (tag !== `v${packageJson.version}`) throw new Error(`tag ${tag} does not match package version ${packageJson.version}`);
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("--commit must be a full 40-hex commit");
  if (packageJson.dependencies || packageJson.devDependencies) throw new Error("source release must remain dependency-free");
  return packageJson.version;
}

export function buildUpgradePackageDirectory({ sourceRoot = root, packageRoot, tag, commit }) {
  if (!packageRoot) throw new Error("packageRoot is required");
  if (existsSync(packageRoot)) throw new Error(`package output already exists: ${packageRoot}`);
  const version = assertReleaseInputs(sourceRoot, tag, commit);
  mkdirSync(packageRoot, { recursive: true });
  for (const [source, target] of RELEASE_FILES) {
    const destination = join(packageRoot, target);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(sourceRoot, source), destination);
  }
  chmodSync(join(packageRoot, "bin", "vibehub-upgrade.mjs"), 0o755);
  const packageJson = {
    name: "vibehub-upgrade",
    version,
    private: true,
    type: "module",
    bin: { "vibehub-upgrade": "bin/vibehub-upgrade.mjs" },
    engines: { node: ">=20" },
  };
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  const contracts = Object.fromEntries(CONTRACTS.map((name) => {
    const path = `vibehub-core/contracts/${name}`;
    return [path, sha256(readFileSync(join(packageRoot, path)))];
  }));
  const identity = {
    schema_version: 1,
    version,
    tag,
    commit,
    project_format: JSON.parse(readFileSync(join(packageRoot, "vibehub-core/contracts/versions.json"), "utf8")).project_format,
    coordinator_sha256: sha256(readFileSync(join(packageRoot, "bin/vibehub-upgrade.mjs"))),
    engine_sha256: sha256(readFileSync(join(packageRoot, "vibehub-core/scripts/vh.mjs"))),
    migrations_sha256: sha256(readFileSync(join(packageRoot, "vibehub-migrate/references/migrations.json"))),
    contract_sha256: contracts,
  };
  writeFileSync(join(packageRoot, "release-identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  return { packageRoot, version, files: packageFiles(packageRoot).map((path) => relative(packageRoot, path).split(sep).join("/")) };
}

export function buildUpgradePackage({ sourceRoot = root, outDir, tag, commit }) {
  if (!outDir) throw new Error("outDir is required");
  mkdirSync(outDir, { recursive: true });
  const holder = mkdtempSync(join(tmpdir(), "vibehub-upgrade-package-"));
  const packageRoot = join(holder, "package");
  try {
    const built = buildUpgradePackageDirectory({ sourceRoot, packageRoot, tag, commit });
    const archive = join(outDir, "vibehub-upgrade.tgz");
    const checksum = `${archive}.sha256`;
    const bytes = gzipSync(tarBytes(packageRoot), { level: 9, mtime: 0 });
    writeFileSync(archive, bytes, { flag: "wx" });
    writeFileSync(checksum, `${sha256(bytes)}  ${basename(archive)}\n`, { flag: "wx" });
    return { ...built, packageRoot: undefined, archive, checksum, sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    rmSync(holder, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!["--out", "--tag", "--commit"].includes(name) || !argv[index + 1]) {
      throw new Error("Usage: build-upgrade-package.mjs --out <directory> --tag <vX.Y.Z> --commit <40-hex>");
    }
    values[name.slice(2)] = argv[index + 1];
  }
  if (!values.out || !values.tag || !values.commit) {
    throw new Error("Usage: build-upgrade-package.mjs --out <directory> --tag <vX.Y.Z> --commit <40-hex>");
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify({ ok: true, ...buildUpgradePackage({
    outDir: resolve(args.out),
    tag: args.tag,
    commit: args.commit,
  }) })}\n`);
}

export { CONTRACTS, RELEASE_FILES };
