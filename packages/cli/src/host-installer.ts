import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_REPOSITORY = "VW-ai/vibehub-plugin";
const MARKETPLACE_NAME = "vibehub";
const PLUGIN_ID = "vibehub@vibehub";
const EXPECTED_RUNTIME_PACKAGES = [
  "@vw-ai/vibehub-core",
  "@vw-ai/vibehub-cli",
  "@vw-ai/vibehub-workbench-mcp",
] as const;

export type VibeHubHost = "claude" | "codex";
export type HostSelection = "auto" | "all" | VibeHubHost[];

export interface HostInstallOptions {
  hosts: HostSelection;
  version?: string;
  repository?: string;
  source?: string;
  installDir?: string;
  replaceExisting?: boolean;
}

export interface CommandInvocation {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface CommandOutput {
  status: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface HostInstallerDependencies {
  run: (
    command: string,
    args: string[],
    invocation?: CommandInvocation,
  ) => CommandOutput;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  now: () => string;
  binaries: {
    gh: string;
    tar: string;
    claude: string;
    codex: string;
  };
}

export interface HostInstallReceipt {
  schemaVersion: 1;
  ok: boolean;
  outcome: "installed" | "repaired" | "partial";
  repository: string;
  version: string;
  marketplacePath: string;
  distribution: {
    source: "github-release" | "local";
    digest: `sha256:${string}`;
    contentDigest: `sha256:${string}`;
    changed: boolean;
    previousAvailable: boolean;
  };
  hosts: Partial<Record<VibeHubHost, {
    status: "installed" | "updated" | "failed";
    version: string | null;
    message?: string;
  }>>;
}

interface PreparedMarketplace {
  root: string;
  version: string;
  digest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
  source: "github-release" | "local";
  cleanupRoot: string;
}

interface InstallerState {
  schemaVersion: 1;
  repository: string;
  version: string;
  digest: `sha256:${string}`;
  contentDigest: `sha256:${string}`;
  marketplacePath: string;
  source: "github-release" | "local";
  installedAt: string;
  hosts: HostInstallReceipt["hosts"];
}

interface InstallerLockOwner {
  schemaVersion: 1;
  token: string;
  pid: number;
  hostname: string;
  createdAtMs: number;
}

const INSTALL_LOCK_WAIT_MS = 30_000;
const INSTALL_LOCK_STALE_MS = 10 * 60_000;

function defaultRun(
  command: string,
  args: string[],
  invocation: CommandInvocation = {},
): CommandOutput {
  const result = spawnSync(command, args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: "utf8",
    timeout: invocation.timeoutMs ?? 120_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function defaultHostInstallerDependencies(): HostInstallerDependencies {
  return {
    run: defaultRun,
    env: process.env,
    homeDir: os.homedir(),
    now: () => new Date().toISOString(),
    binaries: {
      gh: process.env["VIBEHUB_GH_BIN"] || "gh",
      tar: process.env["VIBEHUB_TAR_BIN"] || "tar",
      claude: process.env["CLAUDE_BIN"] || "claude",
      codex: process.env["CODEX_BIN"] || "codex",
    },
  };
}

function redact(value: string, env: NodeJS.ProcessEnv): string {
  let redacted = value;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const secret = env[name];
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function commandError(
  command: string,
  args: string[],
  output: CommandOutput,
  env: NodeJS.ProcessEnv,
): Error {
  const detail = [output.error?.message, output.stdout, output.stderr]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n")
    .trim();
  const message =
    `${command} ${args.join(" ")} failed with exit ${output.status}` +
    (detail ? `\n${detail}` : "");
  return new Error(redact(message, env));
}

function runChecked(
  dependencies: HostInstallerDependencies,
  command: string,
  args: string[],
  invocation: CommandInvocation = {},
): CommandOutput {
  const output = dependencies.run(command, args, {
    ...invocation,
    env: invocation.env ?? dependencies.env,
  });
  if (output.error || output.status !== 0) {
    throw commandError(command, args, output, dependencies.env);
  }
  return output;
}

function runJson<T>(
  dependencies: HostInstallerDependencies,
  command: string,
  args: string[],
  invocation: CommandInvocation = {},
): T {
  const output = runChecked(dependencies, command, args, invocation);
  try {
    return JSON.parse(output.stdout) as T;
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function commandAvailable(
  dependencies: HostInstallerDependencies,
  command: string,
): boolean {
  const output = dependencies.run(command, ["--version"], {
    env: dependencies.env,
    timeoutMs: 10_000,
  });
  return !output.error && output.status === 0;
}

function resolveHosts(
  selection: HostSelection,
  dependencies: HostInstallerDependencies,
): VibeHubHost[] {
  const available = {
    claude: commandAvailable(dependencies, dependencies.binaries.claude),
    codex: commandAvailable(dependencies, dependencies.binaries.codex),
  };
  const requested =
    selection === "auto"
      ? (Object.entries(available)
          .filter(([, present]) => present)
          .map(([host]) => host) as VibeHubHost[])
      : selection === "all"
        ? (["claude", "codex"] as const)
        : [...new Set(selection)];
  if (requested.length === 0) {
    throw new Error(
      "neither Claude Code nor Codex is installed; install at least one host and retry",
    );
  }
  const missing = requested.filter((host) => !available[host]);
  if (missing.length > 0) {
    throw new Error(
      `requested host executable${
        missing.length === 1 ? " is" : "s are"
      } unavailable: ${missing.join(", ")}`,
    );
  }
  return [...requested];
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    throw new Error(
      `invalid JSON at ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertSafeTree(root: string): void {
  const visit = (relative: string): void => {
    const current = path.join(root, relative);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const absolute = path.join(root, child);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`marketplace contains an unsafe symbolic link: ${child}`);
      }
      if (stat.isDirectory()) visit(child);
      else if (!stat.isFile()) {
        throw new Error(`marketplace contains a non-regular entry: ${child}`);
      }
    }
  };
  visit("");
}

function listFiles(root: string, relative = ""): string[] {
  return fs
    .readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.posix.join(relative.split(path.sep).join("/"), entry.name);
      return entry.isDirectory()
        ? listFiles(root, child.split("/").join(path.sep))
        : [child];
    })
    .sort();
}

function treeDigest(root: string): `sha256:${string}` {
  assertSafeTree(root);
  const hash = crypto.createHash("sha256");
  for (const relative of listFiles(root)) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, relative.split("/").join(path.sep))));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function fileDigest(file: string): `sha256:${string}` {
  return `sha256:${crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex")}`;
}

export function assertSafeArchiveEntries(
  paths: string[],
  verboseEntries: string[],
): void {
  if (paths.length === 0) throw new Error("marketplace archive is empty");
  for (const raw of paths) {
    const entry = raw.replace(/^\.\//, "");
    if (!entry) continue;
    if (
      raw.includes("\\") ||
      path.posix.isAbsolute(entry) ||
      entry.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`marketplace archive contains an unsafe path: ${raw}`);
    }
  }
  for (const entry of verboseEntries) {
    const type = entry[0];
    if (type !== "-" && type !== "d") {
      throw new Error(
        `marketplace archive contains an unsafe link or special entry: ${entry}`,
      );
    }
  }
}

export function verifyArchiveChecksum(
  archive: string,
  checksumFile: string,
): `sha256:${string}` {
  const archiveName = path.basename(archive);
  const line = fs.readFileSync(checksumFile, "utf8").trim();
  const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
  if (!match || match[2] !== archiveName) {
    throw new Error(`invalid checksum receipt for ${archiveName}`);
  }
  const actual = fileDigest(archive);
  const expected = `sha256:${match[1]!.toLowerCase()}` as const;
  if (actual !== expected) {
    throw new Error(
      `marketplace archive checksum mismatch: expected ${expected}, got ${actual}`,
    );
  }
  return actual;
}

export function validateReleaseMarketplace(
  root: string,
  expectedVersion?: string,
): string {
  assertSafeTree(root);
  const marker = path.join(root, ".vibehub-release-marketplace");
  if (!fs.existsSync(marker) || fs.readFileSync(marker, "utf8").trim() !== "vibehub") {
    throw new Error("directory is not a VibeHub release marketplace");
  }
  const release = readJson<{
    schemaVersion?: unknown;
    name?: unknown;
    version?: unknown;
    runtime?: { packages?: unknown };
  }>(path.join(root, "release.json"));
  if (
    release.schemaVersion !== 2 ||
    release.name !== MARKETPLACE_NAME ||
    typeof release.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(release.version)
  ) {
    throw new Error("release.json does not identify a supported VibeHub release");
  }
  if (expectedVersion && release.version !== expectedVersion) {
    throw new Error(
      `marketplace version ${release.version} does not match requested version ${expectedVersion}`,
    );
  }
  const expectedPackages = EXPECTED_RUNTIME_PACKAGES.map(
    (name) => `${name}@${release.version}`,
  );
  if (
    JSON.stringify(release.runtime?.packages) !== JSON.stringify(expectedPackages)
  ) {
    throw new Error("release.json runtime package identities do not match the release");
  }

  const claudeMarketplace = readJson<{
    name?: unknown;
    plugins?: Array<{ name?: unknown; version?: unknown; source?: unknown }>;
  }>(path.join(root, ".claude-plugin", "marketplace.json"));
  const claudePlugin = claudeMarketplace.plugins?.[0];
  if (
    claudeMarketplace.name !== MARKETPLACE_NAME ||
    claudePlugin?.name !== MARKETPLACE_NAME ||
    claudePlugin.version !== release.version ||
    claudePlugin.source !== "./plugins/vibehub"
  ) {
    throw new Error("Claude marketplace manifest does not match the release");
  }

  const codexMarketplace = readJson<{
    name?: unknown;
    plugins?: Array<{
      name?: unknown;
      source?: { source?: unknown; path?: unknown };
    }>;
  }>(path.join(root, ".agents", "plugins", "marketplace.json"));
  const codexPlugin = codexMarketplace.plugins?.[0];
  if (
    codexMarketplace.name !== MARKETPLACE_NAME ||
    codexPlugin?.name !== MARKETPLACE_NAME ||
    codexPlugin.source?.source !== "local" ||
    codexPlugin.source.path !== "./plugins/vibehub"
  ) {
    throw new Error("Codex marketplace manifest does not match the release");
  }

  for (const relative of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const manifest = readJson<{ name?: unknown; version?: unknown }>(
      path.join(root, "plugins", "vibehub", relative),
    );
    if (
      manifest.name !== MARKETPLACE_NAME ||
      manifest.version !== release.version
    ) {
      throw new Error(`${relative} does not match release ${release.version}`);
    }
  }
  if (
    !fs.existsSync(
      path.join(root, "plugins", "vibehub", "runtime", "vibehub-runtime.mjs"),
    )
  ) {
    throw new Error("release marketplace is missing its runtime launcher");
  }
  return release.version;
}

function readState(file: string): InstallerState | null {
  if (!fs.existsSync(file)) return null;
  try {
    const state = readJson<InstallerState>(file);
    const validHosts =
      typeof state.hosts === "object" &&
      state.hosts !== null &&
      Object.entries(state.hosts).every(
        ([host, receipt]) =>
          (host === "claude" || host === "codex") &&
          typeof receipt === "object" &&
          receipt !== null &&
          (receipt.status === "installed" ||
            receipt.status === "updated" ||
            receipt.status === "failed") &&
          (typeof receipt.version === "string" || receipt.version === null) &&
          (receipt.message === undefined ||
            typeof receipt.message === "string"),
      );
    return state.schemaVersion === 1 &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(state.repository) &&
      /^\d+\.\d+\.\d+$/.test(state.version) &&
      /^sha256:[a-f0-9]{64}$/.test(state.digest) &&
      /^sha256:[a-f0-9]{64}$/.test(state.contentDigest) &&
      typeof state.marketplacePath === "string" &&
      (state.source === "github-release" || state.source === "local") &&
      typeof state.installedAt === "string" &&
      validHosts
      ? state
      : null;
  } catch {
    return null;
  }
}

function wait(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function readLockOwner(lockRoot: string): InstallerLockOwner | null {
  try {
    const owner = readJson<InstallerLockOwner>(
      path.join(lockRoot, "owner.json"),
    );
    return owner.schemaVersion === 1 &&
      typeof owner.token === "string" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.hostname === "string" &&
      Number.isFinite(owner.createdAtMs)
      ? owner
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function acquireInstallerLock(distributionRoot: string): () => void {
  const lockRoot = path.join(distributionRoot, ".install.lock");
  const token = crypto.randomUUID();
  const owner: InstallerLockOwner = {
    schemaVersion: 1,
    token,
    pid: process.pid,
    hostname: os.hostname(),
    createdAtMs: Date.now(),
  };
  const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockRoot, { mode: 0o700 });
      fs.writeFileSync(
        path.join(lockRoot, "owner.json"),
        `${JSON.stringify(owner)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      return () => {
        const current = readLockOwner(lockRoot);
        if (current?.token !== token) return;
        const released = `${lockRoot}.released-${token}`;
        try {
          fs.renameSync(lockRoot, released);
          fs.rmSync(released, { recursive: true, force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let lockStat: fs.Stats;
    try {
      lockStat = fs.lstatSync(lockRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
      throw new Error(`installer lock path is unsafe: ${lockRoot}`);
    }
    const existing = readLockOwner(lockRoot);
    const stale =
      existing !== null
        ? existing.hostname === os.hostname()
          ? !processIsAlive(existing.pid)
          : Date.now() - existing.createdAtMs > INSTALL_LOCK_STALE_MS
        : Date.now() - lockStat.mtimeMs > INSTALL_LOCK_STALE_MS;
    if (stale) {
      const claimName = `.recovery-${crypto.randomUUID()}`;
      const claim = path.join(lockRoot, claimName);
      try {
        fs.writeFileSync(claim, `${token}\n`, { mode: 0o600, flag: "wx" });
        wait(100);
        const current = readLockOwner(lockRoot);
        const claims = fs
          .readdirSync(lockRoot)
          .filter((entry) => entry.startsWith(".recovery-"))
          .sort();
        if (
          claims[0] === claimName &&
          ((existing === null && current === null) ||
            current?.token === existing?.token)
        ) {
          const quarantined = `${lockRoot}.stale-${crypto.randomUUID()}`;
          fs.renameSync(lockRoot, quarantined);
          fs.rmSync(quarantined, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if (
          !["ENOENT", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        ) {
          throw error;
        }
      }
    }
    wait(100);
  }
  throw new Error(
    `timed out waiting for another VibeHub host installation at ${distributionRoot}`,
  );
}

function pathIsWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function resolvePhysicalPath(candidate: string): string {
  const suffix: string[] = [];
  let existing = path.resolve(candidate);
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.resolve(fs.realpathSync(existing), ...suffix);
}

function resolveRequestedVersion(value: string | undefined): string {
  const requested = value ?? "latest";
  if (requested !== "latest" && !/^\d+\.\d+\.\d+$/.test(requested)) {
    throw new Error("--version must be latest or MAJOR.MINOR.PATCH");
  }
  return requested;
}

function prepareLocalMarketplace(
  source: string,
  distributionRoot: string,
  expectedVersion?: string,
): PreparedMarketplace {
  const resolved = path.resolve(source);
  const sourceStat = fs.lstatSync(resolved);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`local marketplace source is not a directory: ${resolved}`);
  }
  const version = validateReleaseMarketplace(resolved, expectedVersion);
  const digest = treeDigest(resolved);
  const cleanupRoot = fs.mkdtempSync(
    path.join(distributionRoot, ".prepare-local-"),
  );
  const root = path.join(cleanupRoot, "marketplace");
  fs.cpSync(resolved, root, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  const preparedStat = fs.lstatSync(root);
  if (preparedStat.isSymbolicLink() || !preparedStat.isDirectory()) {
    throw new Error("prepared marketplace is not a real directory");
  }
  validateReleaseMarketplace(root, version);
  return {
    root,
    version,
    digest,
    contentDigest: digest,
    source: "local",
    cleanupRoot,
  };
}

function prepareGithubMarketplace(
  repository: string,
  requestedVersion: string,
  distributionRoot: string,
  dependencies: HostInstallerDependencies,
): PreparedMarketplace {
  if (!commandAvailable(dependencies, dependencies.binaries.gh)) {
    throw new Error(
      "GitHub CLI is required for private release installation; install gh and run `gh auth login --hostname github.com`",
    );
  }
  runChecked(
    dependencies,
    dependencies.binaries.gh,
    ["auth", "status", "--hostname", "github.com"],
    { timeoutMs: 15_000 },
  );
  const releaseArgs =
    requestedVersion === "latest"
      ? ["release", "view", "--repo", repository]
      : ["release", "view", `v${requestedVersion}`, "--repo", repository];
  const release = runJson<{
    tagName?: unknown;
    isDraft?: unknown;
    isPrerelease?: unknown;
  }>(
    dependencies,
    dependencies.binaries.gh,
    [...releaseArgs, "--json", "tagName,isDraft,isPrerelease"],
    { timeoutMs: 30_000 },
  );
  if (
    typeof release.tagName !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(release.tagName)
  ) {
    throw new Error("GitHub release does not have a supported VibeHub version tag");
  }
  if (release.isPrerelease === true) {
    throw new Error("VibeHub installer does not accept prerelease artifacts");
  }
  if (
    release.isDraft === true &&
    dependencies.env["VIBEHUB_ALLOW_DRAFT_RELEASE"] !== "1"
  ) {
    throw new Error("VibeHub installer does not accept unpublished draft releases");
  }
  const version = release.tagName.slice(1);
  if (requestedVersion !== "latest" && version !== requestedVersion) {
    throw new Error(
      `GitHub resolved ${release.tagName}; expected v${requestedVersion}`,
    );
  }

  const cleanupRoot = fs.mkdtempSync(
    path.join(distributionRoot, ".prepare-release-"),
  );
  try {
    const downloads = path.join(cleanupRoot, "downloads");
    const root = path.join(cleanupRoot, "marketplace");
    fs.mkdirSync(downloads);
    fs.mkdirSync(root);
    const archiveName = `vibehub-${version}-marketplace.tar.gz`;
    runChecked(
      dependencies,
      dependencies.binaries.gh,
      [
        "release",
        "download",
        release.tagName,
        "--repo",
        repository,
        "--pattern",
        archiveName,
        "--pattern",
        `${archiveName}.sha256`,
        "--dir",
        downloads,
      ],
      { timeoutMs: 120_000 },
    );
    const archive = path.join(downloads, archiveName);
    const checksum = `${archive}.sha256`;
    if (!fs.existsSync(archive) || !fs.existsSync(checksum)) {
      throw new Error(`GitHub release v${version} is missing installer assets`);
    }
    const digest = verifyArchiveChecksum(archive, checksum);
    const listing = runChecked(
      dependencies,
      dependencies.binaries.tar,
      ["-tzf", archive],
      { env: { ...dependencies.env, LC_ALL: "C" }, timeoutMs: 30_000 },
    ).stdout.split(/\r?\n/).filter(Boolean);
    const verbose = runChecked(
      dependencies,
      dependencies.binaries.tar,
      ["-tvzf", archive],
      { env: { ...dependencies.env, LC_ALL: "C" }, timeoutMs: 30_000 },
    ).stdout.split(/\r?\n/).filter(Boolean);
    assertSafeArchiveEntries(listing, verbose);
    runChecked(
      dependencies,
      dependencies.binaries.tar,
      ["-xzf", archive, "-C", root],
      { timeoutMs: 60_000 },
    );
    validateReleaseMarketplace(root, version);
    const contentDigest = treeDigest(root);
    return {
      root,
      version,
      digest,
      contentDigest,
      source: "github-release",
      cleanupRoot,
    };
  } catch (error) {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
    throw error;
  }
}

function installDistribution(
  prepared: PreparedMarketplace,
  distributionRoot: string,
  state: InstallerState | null,
): {
  marketplacePath: string;
  changed: boolean;
  previousAvailable: boolean;
} {
  const marketplacePath = path.join(distributionRoot, "marketplace");
  const previousPath = path.join(distributionRoot, "marketplace.previous");
  const preparedStat = fs.lstatSync(prepared.root);
  if (preparedStat.isSymbolicLink() || !preparedStat.isDirectory()) {
    throw new Error("prepared marketplace is not a real directory");
  }
  for (const existing of [marketplacePath, previousPath]) {
    if (fs.existsSync(existing)) {
      const stat = fs.lstatSync(existing);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          `refusing to replace a non-directory installer path: ${existing}`,
        );
      }
      if (state === null) {
        validateReleaseMarketplace(existing);
      }
    }
  }
  let adoptExistingWithoutState = false;
  if (state === null && fs.existsSync(marketplacePath)) {
    try {
      validateReleaseMarketplace(marketplacePath, prepared.version);
      adoptExistingWithoutState =
        treeDigest(marketplacePath) === prepared.contentDigest;
    } catch {
      adoptExistingWithoutState = false;
    }
  }
  if (
    state === null &&
    !adoptExistingWithoutState &&
    (fs.existsSync(marketplacePath) || fs.existsSync(previousPath))
  ) {
    throw new Error(
      "installer state is missing or invalid for the existing managed marketplace",
    );
  }
  let currentWasValid = false;
  if (fs.existsSync(marketplacePath) && state) {
    try {
      validateReleaseMarketplace(marketplacePath, state.version);
      currentWasValid =
        treeDigest(marketplacePath) === state.contentDigest;
    } catch {
      currentWasValid = false;
    }
  }
  if (
    (adoptExistingWithoutState ||
      (state?.version === prepared.version &&
        state.digest === prepared.digest &&
        state.contentDigest === prepared.contentDigest)) &&
    fs.existsSync(marketplacePath)
  ) {
    try {
      validateReleaseMarketplace(marketplacePath, prepared.version);
      if (treeDigest(marketplacePath) === prepared.contentDigest) {
        fs.rmSync(prepared.cleanupRoot, { recursive: true, force: true });
        return {
          marketplacePath,
          changed: false,
          previousAvailable: fs.existsSync(previousPath),
        };
      }
    } catch {
      // A verified prepared artifact is already staged. Fall through to the
      // atomic replacement path so a damaged managed copy repairs itself.
    }
  }

  if (fs.existsSync(previousPath)) {
    fs.rmSync(previousPath, { recursive: true, force: true });
  }
  let movedCurrent = false;
  try {
    if (fs.existsSync(marketplacePath)) {
      fs.renameSync(marketplacePath, previousPath);
      movedCurrent = true;
    }
    fs.renameSync(prepared.root, marketplacePath);
    validateReleaseMarketplace(marketplacePath, prepared.version);
    if (treeDigest(marketplacePath) !== prepared.contentDigest) {
      throw new Error("installed marketplace failed post-swap verification");
    }
    if (movedCurrent && !currentWasValid && fs.existsSync(previousPath)) {
      fs.rmSync(previousPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (movedCurrent && fs.existsSync(previousPath)) {
      if (fs.existsSync(marketplacePath)) {
        fs.rmSync(marketplacePath, { recursive: true, force: true });
      }
      fs.renameSync(previousPath, marketplacePath);
    }
    throw error;
  } finally {
    fs.rmSync(prepared.cleanupRoot, { recursive: true, force: true });
  }
  return {
    marketplacePath,
    changed: true,
    previousAvailable: movedCurrent && currentWasValid,
  };
}

function samePath(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function pluginTreeMatches(
  installPath: unknown,
  expectedDigest: `sha256:${string}`,
): boolean {
  if (typeof installPath !== "string" || !fs.existsSync(installPath)) {
    return false;
  }
  try {
    return treeDigest(fs.realpathSync(installPath)) === expectedDigest;
  } catch {
    return false;
  }
}

function installClaude(
  marketplacePath: string,
  expectedVersion: string,
  replaceExisting: boolean,
  dependencies: HostInstallerDependencies,
): { status: "installed" | "updated"; version: string } {
  const bin = dependencies.binaries.claude;
  const expectedPluginRoot = path.join(
    marketplacePath,
    "plugins",
    MARKETPLACE_NAME,
  );
  const expectedPluginDigest = treeDigest(expectedPluginRoot);
  const marketplaces = runJson<Array<{
    name?: unknown;
    path?: unknown;
    installLocation?: unknown;
  }>>(dependencies, bin, ["plugin", "marketplace", "list", "--json"]);
  const existingMarketplace = marketplaces.find(
    (entry) => entry.name === MARKETPLACE_NAME,
  );
  const existingSource =
    existingMarketplace?.path ?? existingMarketplace?.installLocation;
  if (
    existingMarketplace &&
    !samePath(existingSource, marketplacePath) &&
    !replaceExisting
  ) {
    throw new Error(
      "Claude already has a different marketplace named vibehub; rerun with --replace-existing after confirming it is safe to migrate",
    );
  }
  if (existingMarketplace && !samePath(existingSource, marketplacePath)) {
    runChecked(dependencies, bin, [
      "plugin",
      "marketplace",
      "remove",
      MARKETPLACE_NAME,
      "--scope",
      "user",
    ]);
  }
  runChecked(dependencies, bin, [
    "plugin",
    "marketplace",
    "add",
    marketplacePath,
    "--scope",
    "user",
  ]);
  const installedBeforeEntry = runJson<Array<{
    id?: unknown;
    scope?: unknown;
    installPath?: unknown;
  }>>(dependencies, bin, ["plugin", "list", "--json"]).find(
    (entry) => entry.id === PLUGIN_ID && entry.scope === "user",
  );
  const installedBefore = Boolean(installedBeforeEntry);
  if (
    installedBeforeEntry &&
    !pluginTreeMatches(installedBeforeEntry.installPath, expectedPluginDigest)
  ) {
    runChecked(dependencies, bin, [
      "plugin",
      "uninstall",
      PLUGIN_ID,
      "--scope",
      "user",
      "--keep-data",
    ]);
  }
  runChecked(
    dependencies,
    bin,
    installedBefore &&
      pluginTreeMatches(
        installedBeforeEntry?.installPath,
        expectedPluginDigest,
      )
      ? ["plugin", "update", PLUGIN_ID, "--scope", "user"]
      : ["plugin", "install", PLUGIN_ID, "--scope", "user"],
  );
  const readInstalled = () =>
    runJson<Array<{
      id?: unknown;
      version?: unknown;
      scope?: unknown;
      enabled?: unknown;
      installPath?: unknown;
    }>>(dependencies, bin, ["plugin", "list", "--json"]).find(
      (entry) => entry.id === PLUGIN_ID && entry.scope === "user",
    );
  let installed = readInstalled();
  if (
    installed &&
    !pluginTreeMatches(installed.installPath, expectedPluginDigest)
  ) {
    runChecked(dependencies, bin, [
      "plugin",
      "uninstall",
      PLUGIN_ID,
      "--scope",
      "user",
      "--keep-data",
    ]);
    runChecked(dependencies, bin, [
      "plugin",
      "install",
      PLUGIN_ID,
      "--scope",
      "user",
    ]);
    installed = readInstalled();
  }
  if (
    installed?.version !== expectedVersion ||
    installed.enabled !== true ||
    !pluginTreeMatches(installed.installPath, expectedPluginDigest)
  ) {
    throw new Error(
      `Claude did not materialize and enable ${PLUGIN_ID}@${expectedVersion} exactly`,
    );
  }
  return {
    status: installedBefore ? "updated" : "installed",
    version: expectedVersion,
  };
}

function installCodex(
  marketplacePath: string,
  expectedVersion: string,
  replaceExisting: boolean,
  dependencies: HostInstallerDependencies,
): { status: "installed" | "updated"; version: string } {
  const bin = dependencies.binaries.codex;
  const expectedPluginRoot = path.join(
    marketplacePath,
    "plugins",
    MARKETPLACE_NAME,
  );
  const expectedPluginDigest = treeDigest(expectedPluginRoot);
  const marketplaces = runJson<{
    marketplaces?: Array<{
      name?: unknown;
      root?: unknown;
      marketplaceSource?: { source?: unknown };
    }>;
  }>(dependencies, bin, ["plugin", "marketplace", "list", "--json"]);
  const existingMarketplace = marketplaces.marketplaces?.find(
    (entry) => entry.name === MARKETPLACE_NAME,
  );
  const existingSource =
    existingMarketplace?.root ?? existingMarketplace?.marketplaceSource?.source;
  if (
    existingMarketplace &&
    !samePath(existingSource, marketplacePath) &&
    !replaceExisting
  ) {
    throw new Error(
      "Codex already has a different marketplace named vibehub; rerun with --replace-existing after confirming it is safe to migrate",
    );
  }
  if (existingMarketplace && !samePath(existingSource, marketplacePath)) {
    runChecked(dependencies, bin, [
      "plugin",
      "marketplace",
      "remove",
      MARKETPLACE_NAME,
      "--json",
    ]);
  }
  runJson(
    dependencies,
    bin,
    ["plugin", "marketplace", "add", marketplacePath, "--json"],
  );
  const readInstalled = () =>
    runJson<{
      installed?: Array<{
        pluginId?: unknown;
        version?: unknown;
        installed?: unknown;
        enabled?: unknown;
        installedPath?: unknown;
      }>;
    }>(dependencies, bin, ["plugin", "list", "--available", "--json"])
      .installed?.find((entry) => entry.pluginId === PLUGIN_ID);
  const installedBeforeEntry = readInstalled();
  const installedBefore = Boolean(installedBeforeEntry);
  if (
    installedBeforeEntry &&
    typeof installedBeforeEntry.installedPath === "string" &&
    !pluginTreeMatches(
      installedBeforeEntry.installedPath,
      expectedPluginDigest,
    )
  ) {
    runJson(
      dependencies,
      bin,
      ["plugin", "remove", PLUGIN_ID, "--json"],
    );
  }
  let installResult = runJson<{ installedPath?: unknown }>(
    dependencies,
    bin,
    ["plugin", "add", PLUGIN_ID, "--json"],
  );
  if (
    !pluginTreeMatches(installResult.installedPath, expectedPluginDigest)
  ) {
    runJson(
      dependencies,
      bin,
      ["plugin", "remove", PLUGIN_ID, "--json"],
    );
    installResult = runJson<{ installedPath?: unknown }>(
      dependencies,
      bin,
      ["plugin", "add", PLUGIN_ID, "--json"],
    );
  }
  const installed = readInstalled();
  if (
    installed?.version !== expectedVersion ||
    installed.installed !== true ||
    installed.enabled !== true ||
    !pluginTreeMatches(installResult.installedPath, expectedPluginDigest)
  ) {
    throw new Error(
      `Codex did not materialize and enable ${PLUGIN_ID}@${expectedVersion} exactly`,
    );
  }
  return {
    status: installedBefore ? "updated" : "installed",
    version: expectedVersion,
  };
}

function writeState(file: string, state: InstallerState): void {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function installVibeHubHosts(
  options: HostInstallOptions,
  dependencies: HostInstallerDependencies = defaultHostInstallerDependencies(),
): HostInstallReceipt {
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new Error("VibeHub host installation requires Node.js 20 or newer");
  }
  if (process.platform === "win32") {
    throw new Error(
      "VibeHub host installation is currently certified on macOS and Linux only",
    );
  }
  const repository = options.repository ?? DEFAULT_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("--repo must be a GitHub OWNER/REPOSITORY");
  }
  const hosts = resolveHosts(options.hosts, dependencies);
  const requestedVersion = resolveRequestedVersion(options.version);
  const distributionRoot = path.resolve(
    options.installDir ??
      path.join(dependencies.homeDir, ".vibehub", "distribution"),
  );
  const sourceRoot = options.source
    ? path.resolve(options.source)
    : undefined;
  const physicalDistributionRoot = resolvePhysicalPath(distributionRoot);
  const physicalSourceRoot = sourceRoot
    ? resolvePhysicalPath(sourceRoot)
    : undefined;
  if (
    physicalSourceRoot &&
    (pathIsWithin(physicalDistributionRoot, physicalSourceRoot) ||
      pathIsWithin(physicalSourceRoot, physicalDistributionRoot))
  ) {
    throw new Error(
      "--source and --install-dir must be fully disjoint directories",
    );
  }
  const protectedRoots = new Set([
    path.parse(distributionRoot).root,
    path.resolve(dependencies.homeDir),
    path.resolve(dependencies.homeDir, ".vibehub"),
  ]);
  if (protectedRoots.has(distributionRoot)) {
    throw new Error(
      `refusing to use a broad installer directory: ${distributionRoot}`,
    );
  }
  if (fs.existsSync(distributionRoot)) {
    const stat = fs.lstatSync(distributionRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `installer directory must be a real directory: ${distributionRoot}`,
      );
    }
  }
  fs.mkdirSync(distributionRoot, { recursive: true, mode: 0o700 });
  const ownershipMarker = path.join(
    distributionRoot,
    ".vibehub-installer-owned",
  );
  if (fs.existsSync(ownershipMarker)) {
    if (
      !fs.lstatSync(ownershipMarker).isFile() ||
      fs.readFileSync(ownershipMarker, "utf8").trim() !== "vibehub"
    ) {
      throw new Error(
        `installer ownership marker is invalid: ${ownershipMarker}`,
      );
    }
  } else {
    const occupants = fs.readdirSync(distributionRoot);
    if (
      occupants.length > 0 &&
      !(
        occupants.length === 1 &&
        occupants[0] === path.basename(ownershipMarker) &&
        fs.lstatSync(ownershipMarker).isFile() &&
        fs.readFileSync(ownershipMarker, "utf8").trim() === "vibehub"
      )
    ) {
      throw new Error(
        `installer directory is non-empty but not owned by VibeHub: ${distributionRoot}`,
      );
    }
    if (!fs.existsSync(ownershipMarker)) {
      try {
        fs.writeFileSync(ownershipMarker, "vibehub\n", {
          mode: 0o600,
          flag: "wx",
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          !fs.lstatSync(ownershipMarker).isFile() ||
          fs.readFileSync(ownershipMarker, "utf8").trim() !== "vibehub"
        ) {
          throw error;
        }
      }
    }
  }
  const releaseInstallerLock = acquireInstallerLock(distributionRoot);
  try {
    const statePath = path.join(distributionRoot, "state.json");
    const previousState = readState(statePath);
    const marketplacePath = path.join(distributionRoot, "marketplace");

    let prepared: PreparedMarketplace;
    if (sourceRoot) {
      prepared = prepareLocalMarketplace(
        sourceRoot,
        distributionRoot,
        requestedVersion === "latest" ? undefined : requestedVersion,
      );
    } else if (
      requestedVersion !== "latest" &&
      previousState?.repository === repository &&
      previousState.source === "github-release" &&
      previousState?.version === requestedVersion &&
      previousState.marketplacePath === marketplacePath &&
      fs.existsSync(marketplacePath) &&
      (() => {
        try {
          validateReleaseMarketplace(marketplacePath, requestedVersion);
          return treeDigest(marketplacePath) === previousState.contentDigest;
        } catch {
          return false;
        }
      })()
    ) {
      const version = validateReleaseMarketplace(
        marketplacePath,
        requestedVersion,
      );
      const cleanupRoot = fs.mkdtempSync(
        path.join(distributionRoot, ".prepare-existing-"),
      );
      const root = path.join(cleanupRoot, "marketplace");
      fs.cpSync(marketplacePath, root, { recursive: true });
      prepared = {
        root,
        version,
        digest: previousState.digest,
        contentDigest: previousState.contentDigest,
        source: previousState.source,
        cleanupRoot,
      };
    } else {
      if (!commandAvailable(dependencies, dependencies.binaries.tar)) {
        throw new Error(
          "tar is required to extract the VibeHub release archive",
        );
      }
      prepared = prepareGithubMarketplace(
        repository,
        requestedVersion,
        distributionRoot,
        dependencies,
      );
    }

    const distribution = installDistribution(
      prepared,
      distributionRoot,
      previousState,
    );
    const hostReceipts: HostInstallReceipt["hosts"] = {};
    for (const host of hosts) {
      try {
        hostReceipts[host] =
          host === "claude"
            ? installClaude(
                distribution.marketplacePath,
                prepared.version,
                options.replaceExisting ?? false,
                dependencies,
              )
            : installCodex(
                distribution.marketplacePath,
                prepared.version,
                options.replaceExisting ?? false,
                dependencies,
              );
      } catch (error) {
        hostReceipts[host] = {
          status: "failed",
          version: null,
          message: redact(
            error instanceof Error ? error.message : String(error),
            dependencies.env,
          ),
        };
      }
    }
    const ok = hosts.every((host) => hostReceipts[host]?.status !== "failed");
    const receipt: HostInstallReceipt = {
      schemaVersion: 1,
      ok,
      outcome: ok
        ? distribution.changed
          ? "installed"
          : "repaired"
        : "partial",
      repository,
      version: prepared.version,
      marketplacePath: distribution.marketplacePath,
      distribution: {
        source: prepared.source,
        digest: prepared.digest,
        contentDigest: prepared.contentDigest,
        changed: distribution.changed,
        previousAvailable: distribution.previousAvailable,
      },
      hosts: hostReceipts,
    };
    writeState(statePath, {
      schemaVersion: 1,
      repository,
      version: prepared.version,
      digest: prepared.digest,
      contentDigest: prepared.contentDigest,
      marketplacePath: distribution.marketplacePath,
      source: prepared.source,
      installedAt: dependencies.now(),
      hosts: hostReceipts,
    });
    return receipt;
  } finally {
    releaseInstallerLock();
  }
}
