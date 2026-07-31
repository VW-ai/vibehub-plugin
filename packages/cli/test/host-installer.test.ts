import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeArchiveEntries,
  installVibeHubHosts,
  validateReleaseMarketplace,
  verifyArchiveChecksum,
  type CommandOutput,
  type HostInstallerDependencies,
} from "../src/host-installer.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-host-installer-"));
  temporaryRoots.push(root);
  return root;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createMarketplace(root: string, version = "9.8.7"): string {
  const marketplace = path.join(root, "release");
  const plugin = path.join(marketplace, "plugins", "vibehub");
  fs.mkdirSync(path.join(plugin, "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(marketplace, ".vibehub-release-marketplace"),
    "vibehub\n",
  );
  fs.writeFileSync(path.join(plugin, "runtime", "vibehub-runtime.mjs"), "\n");
  writeJson(path.join(marketplace, "release.json"), {
    schemaVersion: 2,
    name: "vibehub",
    version,
    runtime: {
      packages: [
        `@vw-ai/vibehub-core@${version}`,
        `@vw-ai/vibehub-cli@${version}`,
        `@vw-ai/vibehub-workbench-mcp@${version}`,
      ],
    },
  });
  writeJson(path.join(marketplace, ".claude-plugin", "marketplace.json"), {
    name: "vibehub",
    plugins: [
      {
        name: "vibehub",
        version,
        source: "./plugins/vibehub",
      },
    ],
  });
  writeJson(path.join(marketplace, ".agents", "plugins", "marketplace.json"), {
    name: "vibehub",
    plugins: [
      {
        name: "vibehub",
        source: { source: "local", path: "./plugins/vibehub" },
      },
    ],
  });
  for (const relative of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    writeJson(path.join(plugin, relative), { name: "vibehub", version });
  }
  return marketplace;
}

interface FakeHostState {
  claudeMarketplace: string | null;
  codexMarketplace: string | null;
  claudeVersion: string | null;
  codexVersion: string | null;
  claudeInstallPath?: string | null;
  codexInstallPath?: string | null;
  failClaudeListWith?: string;
  missing?: "claude" | "codex" | "gh" | "tar";
  githubRelease?: {
    marketplace: string;
    version: string;
    draft?: boolean;
    prerelease?: boolean;
    corruptChecksum?: boolean;
    omitChecksum?: boolean;
  };
}

function fakeDependencies(
  homeDir: string,
  state: FakeHostState,
): HostInstallerDependencies {
  const versionAt = (marketplace: string | null): string | null =>
    marketplace
      ? JSON.parse(
          fs.readFileSync(path.join(marketplace, "release.json"), "utf8"),
        ).version
      : null;
  const materialize = (
    host: "claude" | "codex",
    force: boolean,
  ): string => {
    const marketplace =
      host === "claude" ? state.claudeMarketplace : state.codexMarketplace;
    const version = versionAt(marketplace);
    if (!marketplace || !version) {
      throw new Error(`cannot materialize ${host} without a marketplace`);
    }
    const versionKey = host === "claude" ? "claudeVersion" : "codexVersion";
    const pathKey =
      host === "claude" ? "claudeInstallPath" : "codexInstallPath";
    const installPath =
      state[pathKey] ?? path.join(homeDir, `${host}-plugin-cache`);
    if (
      force ||
      state[versionKey] !== version ||
      !fs.existsSync(installPath)
    ) {
      fs.rmSync(installPath, { recursive: true, force: true });
      fs.cpSync(
        path.join(marketplace, "plugins", "vibehub"),
        installPath,
        { recursive: true },
      );
    }
    state[versionKey] = version;
    state[pathKey] = installPath;
    return installPath;
  };
  const removeInstalled = (host: "claude" | "codex"): void => {
    const versionKey = host === "claude" ? "claudeVersion" : "codexVersion";
    const pathKey =
      host === "claude" ? "claudeInstallPath" : "codexInstallPath";
    const installPath = state[pathKey];
    if (installPath) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
    state[versionKey] = null;
    state[pathKey] = null;
  };
  const output = (
    status: number,
    value: unknown = "",
    stderr = "",
  ): CommandOutput => ({
    status,
    stdout: typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
    stderr,
  });
  return {
    env: { GH_TOKEN: "secret-sentinel" },
    homeDir,
    now: () => "2026-07-30T00:00:00.000Z",
    binaries: {
      gh: "fake-gh",
      tar: "fake-tar",
      claude: "fake-claude",
      codex: "fake-codex",
    },
    run(command, args) {
      if (args[0] === "--version") {
        if (
          (command === "fake-claude" && state.missing === "claude") ||
          (command === "fake-codex" && state.missing === "codex") ||
          (command === "fake-gh" && state.missing === "gh") ||
          (command === "fake-tar" && state.missing === "tar")
        ) {
          return output(1, "", "not found");
        }
        return output(0, "1.0.0\n");
      }
      if (command === "fake-gh" && state.githubRelease) {
        if (args.join(" ") === "auth status --hostname github.com") {
          return output(0, "authenticated\n");
        }
        if (
          args[0] === "release" &&
          args[1] === "view" &&
          args.includes("--json")
        ) {
          return output(0, {
            tagName: `v${state.githubRelease.version}`,
            isDraft: state.githubRelease.draft ?? false,
            isPrerelease: state.githubRelease.prerelease ?? false,
          });
        }
        if (args[0] === "release" && args[1] === "download") {
          const destination = args[args.indexOf("--dir") + 1]!;
          const archiveName =
            `vibehub-${state.githubRelease.version}-marketplace.tar.gz`;
          const archive = path.join(destination, archiveName);
          const packed = spawnSync(
            "tar",
            [
              "-czf",
              archive,
              "-C",
              state.githubRelease.marketplace,
              ".",
            ],
            { encoding: "utf8" },
          );
          if (packed.error || packed.status !== 0) {
            return output(
              packed.status ?? 1,
              packed.stdout ?? "",
              packed.stderr ?? packed.error?.message ?? "",
            );
          }
          if (!state.githubRelease.omitChecksum) {
            const digest = state.githubRelease.corruptChecksum
              ? "0".repeat(64)
              : crypto
                  .createHash("sha256")
                  .update(fs.readFileSync(archive))
                  .digest("hex");
            fs.writeFileSync(
              `${archive}.sha256`,
              `${digest}  ${archiveName}\n`,
            );
          }
          return output(0);
        }
      }
      if (command === "fake-tar") {
        const result = spawnSync("tar", args, { encoding: "utf8" });
        return {
          status: result.status ?? 1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          ...(result.error ? { error: result.error } : {}),
        };
      }
      if (command === "fake-claude") {
        if (
          state.failClaudeListWith &&
          args.join(" ") === "plugin marketplace list --json"
        ) {
          return output(1, "", state.failClaudeListWith);
        }
        if (args.join(" ") === "plugin marketplace list --json") {
          return output(
            0,
            state.claudeMarketplace
              ? [
                  {
                    name: "vibehub",
                    path: state.claudeMarketplace,
                    installLocation: state.claudeMarketplace,
                  },
                ]
              : [],
          );
        }
        if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
          state.claudeMarketplace = args[3]!;
          return output(0);
        }
        if (
          args[0] === "plugin" &&
          args[1] === "marketplace" &&
          args[2] === "remove"
        ) {
          state.claudeMarketplace = null;
          return output(0);
        }
        if (args.join(" ") === "plugin list --json") {
          return output(
            0,
            state.claudeVersion
              ? [
                  {
                    id: "vibehub@vibehub",
                    version: state.claudeVersion,
                    scope: "user",
                    enabled: true,
                    installPath: state.claudeInstallPath,
                  },
                ]
              : [],
          );
        }
        if (args[0] === "plugin" && args[1] === "uninstall") {
          removeInstalled("claude");
          return output(0);
        }
        if (args[0] === "plugin" && ["install", "update"].includes(args[1]!)) {
          materialize("claude", args[1] === "install");
          return output(0);
        }
      }
      if (command === "fake-codex") {
        if (args.join(" ") === "plugin marketplace list --json") {
          return output(0, {
            marketplaces: state.codexMarketplace
              ? [
                  {
                    name: "vibehub",
                    root: state.codexMarketplace,
                    marketplaceSource: {
                      sourceType: "local",
                      source: state.codexMarketplace,
                    },
                  },
                ]
              : [],
          });
        }
        if (
          args[0] === "plugin" &&
          args[1] === "marketplace" &&
          args[2] === "remove"
        ) {
          state.codexMarketplace = null;
          return output(0, { removed: true });
        }
        if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
          state.codexMarketplace = args[3]!;
          return output(0, { marketplaceName: "vibehub" });
        }
        if (args.join(" ") === "plugin list --available --json") {
          return output(0, {
            installed: state.codexVersion
              ? [
                  {
                    pluginId: "vibehub@vibehub",
                    version: state.codexVersion,
                    installed: true,
                    enabled: true,
                    installedPath: state.codexInstallPath,
                  },
                ]
              : [],
            available: [],
          });
        }
        if (args.join(" ") === "plugin remove vibehub@vibehub --json") {
          removeInstalled("codex");
          return output(0, { removed: true });
        }
        if (args.join(" ") === "plugin add vibehub@vibehub --json") {
          const installedPath = materialize("codex", false);
          return output(0, {
            pluginId: "vibehub@vibehub",
            installedPath,
          });
        }
      }
      return output(1, "", `unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("private release host installer", () => {
  it("atomically installs one release into both hosts and converges on rerun", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    const first = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    expect(first).toMatchObject({
      ok: true,
      outcome: "installed",
      version: "9.8.7",
      distribution: { source: "local", changed: true },
      hosts: {
        claude: { status: "installed", version: "9.8.7" },
        codex: { status: "installed", version: "9.8.7" },
      },
    });
    expect(validateReleaseMarketplace(first.marketplacePath)).toBe("9.8.7");
    expect(state.claudeMarketplace).toBe(first.marketplacePath);
    expect(state.codexMarketplace).toBe(first.marketplacePath);

    const second = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    expect(second).toMatchObject({
      ok: true,
      outcome: "repaired",
      distribution: { changed: false },
      hosts: {
        claude: { status: "updated", version: "9.8.7" },
        codex: { status: "updated", version: "9.8.7" },
      },
    });
  });

  it("fails closed on a same-name foreign marketplace", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: path.join(root, "foreign"),
      codexMarketplace: null,
      claudeVersion: "1.0.0",
      codexVersion: null,
    };
    const receipt = installVibeHubHosts(
      {
        hosts: ["claude"],
        version: "9.8.7",
        source,
        installDir: path.join(root, "distribution"),
      },
      fakeDependencies(path.join(root, "home"), state),
    );
    expect(receipt).toMatchObject({
      ok: false,
      outcome: "partial",
      hosts: {
        claude: {
          status: "failed",
          version: null,
          message: expect.stringContaining("--replace-existing"),
        },
      },
    });
    expect(state.claudeMarketplace).toBe(path.join(root, "foreign"));
  });

  it("can explicitly migrate an existing marketplace registration", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: path.join(root, "foreign-claude"),
      codexMarketplace: path.join(root, "foreign-codex"),
      claudeVersion: "1.0.0",
      codexVersion: "1.0.0",
    };
    const receipt = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir: path.join(root, "distribution"),
        replaceExisting: true,
      },
      fakeDependencies(path.join(root, "home"), state),
    );
    expect(receipt.ok).toBe(true);
    expect(state.claudeMarketplace).toBe(receipt.marketplacePath);
    expect(state.codexMarketplace).toBe(receipt.marketplacePath);
  });

  it("stages an update before swapping and keeps one valid previous release", () => {
    const root = temporaryRoot();
    const firstSource = createMarketplace(path.join(root, "first"), "9.8.7");
    const secondSource = createMarketplace(path.join(root, "second"), "9.8.8");
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source: firstSource,
        installDir,
      },
      dependencies,
    );
    const updated = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.8",
        source: secondSource,
        installDir,
      },
      dependencies,
    );
    expect(updated).toMatchObject({
      ok: true,
      version: "9.8.8",
      distribution: { changed: true, previousAvailable: true },
      hosts: {
        claude: { status: "updated", version: "9.8.8" },
        codex: { status: "updated", version: "9.8.8" },
      },
    });
    expect(validateReleaseMarketplace(updated.marketplacePath)).toBe("9.8.8");
    expect(
      validateReleaseMarketplace(
        path.join(installDir, "marketplace.previous"),
      ),
    ).toBe("9.8.7");
  });

  it("repairs a damaged managed marketplace and both host caches", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    const first = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    const launcher = path.join("runtime", "vibehub-runtime.mjs");
    fs.writeFileSync(
      path.join(first.marketplacePath, "plugins", "vibehub", launcher),
      "damaged distribution\n",
    );
    fs.writeFileSync(
      path.join(state.claudeInstallPath!, launcher),
      "damaged claude cache\n",
    );
    fs.writeFileSync(
      path.join(state.codexInstallPath!, launcher),
      "damaged codex cache\n",
    );

    const repaired = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    expect(repaired).toMatchObject({
      ok: true,
      outcome: "installed",
      distribution: { changed: true, previousAvailable: false },
      hosts: {
        claude: { status: "updated", version: "9.8.7" },
        codex: { status: "updated", version: "9.8.7" },
      },
    });
    for (const file of [
      path.join(repaired.marketplacePath, "plugins", "vibehub", launcher),
      path.join(state.claudeInstallPath!, launcher),
      path.join(state.codexInstallPath!, launcher),
    ]) {
      expect(fs.readFileSync(file, "utf8")).toBe("\n");
    }
  });

  it("adopts an exact managed marketplace after state-write interruption", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    const first = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    fs.rmSync(path.join(installDir, "state.json"));

    const recovered = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    expect(recovered).toMatchObject({
      ok: true,
      outcome: "repaired",
      marketplacePath: first.marketplacePath,
      distribution: { changed: false },
      hosts: {
        claude: { status: "updated", version: "9.8.7" },
        codex: { status: "updated", version: "9.8.7" },
      },
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(installDir, "state.json"), "utf8"),
      ),
    ).toMatchObject({
      repository: "VW-ai/vibehub-plugin",
      version: "9.8.7",
      source: "local",
    });
  });

  it("rejects a local release whose version does not match", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root, "9.8.7");
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.8",
          source,
          installDir: path.join(root, "distribution"),
        },
        fakeDependencies(path.join(root, "home"), state),
      ),
    ).toThrow("does not match requested version");
    expect(state.claudeMarketplace).toBeNull();
  });

  it("rejects symlinked sources and overlapping source/install roots", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const sourceLink = path.join(root, "release-link");
    fs.symlinkSync(source, sourceLink, "dir");
    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.7",
          source: sourceLink,
          installDir: path.join(root, "distribution-link"),
        },
        dependencies,
      ),
    ).toThrow("local marketplace source is not a directory");

    const nestedInstall = path.join(source, ".installer");
    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.7",
          source,
          installDir: nestedInstall,
        },
        dependencies,
      ),
    ).toThrow("fully disjoint");
    expect(fs.existsSync(nestedInstall)).toBe(false);

    const nestedViaAncestorSymlink = path.join(sourceLink, ".installer");
    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.7",
          source,
          installDir: nestedViaAncestorSymlink,
        },
        dependencies,
      ),
    ).toThrow("fully disjoint");
    expect(fs.existsSync(nestedViaAncestorSymlink)).toBe(false);

    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.7",
          source,
          installDir: root,
        },
        dependencies,
      ),
    ).toThrow("fully disjoint");
  });

  it("does not reuse local or cross-repository bytes as a private release", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    installVibeHubHosts(
      {
        hosts: ["claude"],
        version: "9.8.7",
        source,
        installDir,
      },
      dependencies,
    );
    state.missing = "gh";
    expect(() =>
      installVibeHubHosts(
        {
          hosts: ["claude"],
          version: "9.8.7",
          repository: "another-owner/private-vibehub",
          installDir,
        },
        dependencies,
      ),
    ).toThrow("GitHub CLI is required");
    const persisted = JSON.parse(
      fs.readFileSync(path.join(installDir, "state.json"), "utf8"),
    );
    expect(persisted.repository).toBe("VW-ai/vibehub-plugin");
    expect(persisted.source).toBe("local");
  });

  it("downloads, verifies, extracts, and safely reuses an exact private release", () => {
    const root = temporaryRoot();
    const marketplace = createMarketplace(path.join(root, "asset"));
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
      githubRelease: {
        marketplace,
        version: "9.8.7",
      },
    };
    const dependencies = fakeDependencies(path.join(root, "home"), state);
    const installDir = path.join(root, "distribution");
    const first = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        repository: "VW-ai/vibehub-plugin",
        installDir,
      },
      dependencies,
    );
    expect(first).toMatchObject({
      ok: true,
      version: "9.8.7",
      distribution: {
        source: "github-release",
        changed: true,
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });

    state.missing = "gh";
    const cached = installVibeHubHosts(
      {
        hosts: "all",
        version: "9.8.7",
        repository: "VW-ai/vibehub-plugin",
        installDir,
      },
      dependencies,
    );
    expect(cached).toMatchObject({
      ok: true,
      outcome: "repaired",
      distribution: { source: "github-release", changed: false },
    });
  });

  it("fails closed on unpublished or corrupt GitHub release assets", () => {
    const cases = [
      {
        name: "draft",
        release: { draft: true },
        expected: "unpublished draft",
      },
      {
        name: "prerelease",
        release: { prerelease: true },
        expected: "prerelease",
      },
      {
        name: "checksum",
        release: { corruptChecksum: true },
        expected: "checksum mismatch",
      },
      {
        name: "missing checksum",
        release: { omitChecksum: true },
        expected: "missing installer assets",
      },
    ] as const;
    for (const entry of cases) {
      const root = temporaryRoot();
      const marketplace = createMarketplace(path.join(root, "asset"));
      const state: FakeHostState = {
        claudeMarketplace: null,
        codexMarketplace: null,
        claudeVersion: null,
        codexVersion: null,
        githubRelease: {
          marketplace,
          version: "9.8.7",
          ...entry.release,
        },
      };
      expect(() =>
        installVibeHubHosts(
          {
            hosts: ["claude"],
            version: "9.8.7",
            installDir: path.join(root, "distribution"),
          },
          fakeDependencies(path.join(root, "home"), state),
        ),
        entry.name,
      ).toThrow(entry.expected);
    }
  });

  it("recovers an abandoned installer lock before mutating host state", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const installDir = path.join(root, "distribution");
    const lockRoot = path.join(installDir, ".install.lock");
    fs.mkdirSync(lockRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, ".vibehub-installer-owned"),
      "vibehub\n",
    );
    writeJson(path.join(lockRoot, "owner.json"), {
      schemaVersion: 1,
      token: "abandoned",
      pid: 99_999_999,
      hostname: os.hostname(),
      createdAtMs: Date.now(),
    });
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const receipt = installVibeHubHosts(
      {
        hosts: ["claude"],
        version: "9.8.7",
        source,
        installDir,
      },
      fakeDependencies(path.join(root, "home"), state),
    );
    expect(receipt.ok).toBe(true);
    expect(fs.existsSync(lockRoot)).toBe(false);
  });

  it("retries when a competing installer releases its lock after EEXIST", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const installDir = path.join(root, "distribution");
    const lockRoot = path.join(installDir, ".install.lock");
    fs.mkdirSync(lockRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, ".vibehub-installer-owned"),
      "vibehub\n",
    );
    writeJson(path.join(lockRoot, "owner.json"), {
      schemaVersion: 1,
      token: "competing-installer",
      pid: process.pid,
      hostname: os.hostname(),
      createdAtMs: Date.now(),
    });

    const realLstat = fs.lstatSync.bind(fs);
    let released = false;
    vi.spyOn(fs, "lstatSync").mockImplementation(
      ((target: fs.PathLike, options?: object) => {
        if (path.resolve(target.toString()) === lockRoot && !released) {
          released = true;
          fs.rmSync(lockRoot, { recursive: true, force: true });
          throw Object.assign(new Error("simulated concurrent release"), {
            code: "ENOENT",
          });
        }
        return Reflect.apply(realLstat, fs, [target, options]);
      }) as typeof fs.lstatSync,
    );

    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const receipt = installVibeHubHosts(
      {
        hosts: ["claude"],
        version: "9.8.7",
        source,
        installDir,
      },
      fakeDependencies(path.join(root, "home"), state),
    );
    expect(released).toBe(true);
    expect(receipt.ok).toBe(true);
    expect(fs.existsSync(lockRoot)).toBe(false);
  });

  it("refuses broad or foreign installer-owned paths without deleting them", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const home = path.join(root, "home");
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
    };
    const dependencies = fakeDependencies(home, state);
    expect(() =>
      installVibeHubHosts(
        { hosts: ["claude"], version: "9.8.7", source, installDir: home },
        dependencies,
      ),
    ).toThrow("broad installer directory");

    const installDir = path.join(root, "distribution");
    fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(
      path.join(installDir, ".vibehub-installer-owned"),
      "vibehub\n",
    );
    const foreign = path.join(installDir, "marketplace.previous");
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(foreign, "user.txt"), "preserve me\n");
    expect(() =>
      installVibeHubHosts(
        { hosts: ["claude"], version: "9.8.7", source, installDir },
        dependencies,
      ),
    ).toThrow("not a VibeHub release marketplace");
    expect(fs.readFileSync(path.join(foreign, "user.txt"), "utf8")).toBe(
      "preserve me\n",
    );
  });

  it("verifies archive checksums and rejects unsafe archive metadata", () => {
    const root = temporaryRoot();
    const archive = path.join(root, "vibehub-1.2.3-marketplace.tar.gz");
    fs.writeFileSync(archive, "release");
    const digest = "a4d451ec23463726f72c43d64c710968f6b602cd653b4de8adee1b556240a829";
    const checksum = `${archive}.sha256`;
    fs.writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n`);
    expect(verifyArchiveChecksum(archive, checksum)).toBe(`sha256:${digest}`);
    expect(() =>
      assertSafeArchiveEntries(["./", "../escape"], ["drwxr-xr-x ./"]),
    ).toThrow("unsafe path");
    expect(() =>
      assertSafeArchiveEntries(
        ["./", "./plugins/link"],
        ["lrwxr-xr-x ./plugins/link -> /tmp"],
      ),
    ).toThrow("unsafe link");
  });

  it("redacts GitHub credentials from host errors", () => {
    const root = temporaryRoot();
    const source = createMarketplace(root);
    const state: FakeHostState = {
      claudeMarketplace: null,
      codexMarketplace: null,
      claudeVersion: null,
      codexVersion: null,
      failClaudeListWith: "failed with secret-sentinel",
    };
    const receipt = installVibeHubHosts(
      {
        hosts: ["claude"],
        version: "9.8.7",
        source,
        installDir: path.join(root, "distribution"),
      },
      fakeDependencies(path.join(root, "home"), state),
    );
    expect(receipt.hosts.claude?.message).toContain("[redacted]");
    expect(receipt.hosts.claude?.message).not.toContain("secret-sentinel");
    expect(
      fs.readFileSync(
        path.join(root, "distribution", "state.json"),
        "utf8",
      ),
    ).not.toContain("secret-sentinel");
  });
});
