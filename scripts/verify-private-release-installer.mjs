#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(
    "usage: verify-private-release-installer.mjs vMAJOR.MINOR.PATCH [npm-artifact-directory] [release-asset-directory]",
  );
}
const version = tag.slice(1);
const artifactRoot = resolve(process.argv[3] ?? "dist/npm");
const releaseAssetRoot = resolve(
  process.argv[4] ?? "dist/private-release",
);
const manifest = JSON.parse(
  readFileSync(join(artifactRoot, "manifest.json"), "utf8"),
);
const expectedCliArchive = `vw-ai-vibehub-cli-${version}.tgz`;
const cliArtifact = manifest.packages?.find(
  (entry) =>
    entry.name === "@vw-ai/vibehub-cli" && entry.version === version,
);
if (
  manifest.tag !== tag ||
  cliArtifact?.archive !== expectedCliArchive
) {
  throw new Error(`npm artifact manifest does not describe ${tag}`);
}

const temp = mkdtempSync(join(tmpdir(), "vibehub-private-installer-"));

function output(status, value = "") {
  return {
    status,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  };
}

function inspectTarArchive(archive, expectedPrefix) {
  const paths = spawnSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const entries = spawnSync("tar", ["-tvzf", archive], {
    encoding: "utf8",
    timeout: 60_000,
  });
  for (const listing of [paths, entries]) {
    if (listing.error) throw listing.error;
    if (listing.status !== 0) {
      throw new Error(
        `could not inspect ${archive}\n${listing.stdout}\n${listing.stderr}`,
      );
    }
  }
  const pathEntries = paths.stdout.split(/\r?\n/).filter(Boolean);
  if (pathEntries.length === 0) {
    throw new Error(`${archive} is empty`);
  }
  for (const raw of pathEntries) {
    const entry = raw.replace(/^\.\//, "");
    if (
      raw.includes("\\") ||
      entry.startsWith("/") ||
      !entry.startsWith(expectedPrefix) ||
      entry.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(`${archive} contains an unsafe path: ${raw}`);
    }
  }
  for (const entry of entries.stdout.split(/\r?\n/).filter(Boolean)) {
    if (entry[0] !== "-" && entry[0] !== "d") {
      throw new Error(`${archive} contains a link or special entry: ${entry}`);
    }
  }
}

try {
  const extracted = join(temp, "cli");
  mkdirSync(extracted, { recursive: true });
  inspectTarArchive(
    join(artifactRoot, cliArtifact.archive),
    "package/",
  );
  const unpack = spawnSync(
    "tar",
    ["-xzf", join(artifactRoot, cliArtifact.archive), "-C", extracted],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (unpack.error) throw unpack.error;
  if (unpack.status !== 0) {
    throw new Error(
      `could not unpack the verified CLI artifact\n${unpack.stdout}\n${unpack.stderr}`,
    );
  }
  const installerModule = await import(
    pathToFileURL(
      join(extracted, "package", "dist", "host-installer.js"),
    ).href
  );
  const releaseArchive = join(
    releaseAssetRoot,
    `vibehub-${version}-marketplace.tar.gz`,
  );
  const releaseChecksum = `${releaseArchive}.sha256`;
  installerModule.verifyArchiveChecksum(releaseArchive, releaseChecksum);
  const archivePaths = spawnSync("tar", ["-tzf", releaseArchive], {
    encoding: "utf8",
    timeout: 60_000,
  });
  const archiveEntries = spawnSync("tar", ["-tvzf", releaseArchive], {
    encoding: "utf8",
    timeout: 60_000,
  });
  for (const listing of [archivePaths, archiveEntries]) {
    if (listing.error) throw listing.error;
    if (listing.status !== 0) {
      throw new Error(
        `could not inspect the downloaded release archive\n${listing.stdout}\n${listing.stderr}`,
      );
    }
  }
  installerModule.assertSafeArchiveEntries(
    archivePaths.stdout.split(/\r?\n/).filter(Boolean),
    archiveEntries.stdout.split(/\r?\n/).filter(Boolean),
  );
  const releaseSource = join(temp, "release-source");
  mkdirSync(releaseSource, { recursive: true });
  const extractRelease = spawnSync(
    "tar",
    ["-xzf", releaseArchive, "-C", releaseSource],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (extractRelease.error) throw extractRelease.error;
  if (extractRelease.status !== 0) {
    throw new Error(
      `could not extract the downloaded release archive\n${extractRelease.stdout}\n${extractRelease.stderr}`,
    );
  }
  const defaults = installerModule.defaultHostInstallerDependencies();
  const home = join(temp, "home");
  const installDir = join(temp, "distribution");
  const fakeClaudeCache = join(temp, "claude-plugin-cache");
  mkdirSync(home, { recursive: true });
  let marketplacePath = null;
  let installed = false;

  const dependencies = {
    ...defaults,
    homeDir: home,
    env: {
      ...process.env,
      HOME: home,
    },
    binaries: {
      ...defaults.binaries,
      claude: "claude-release-verifier",
      codex: "codex-release-verifier",
    },
    run(command, args, invocation) {
      if (command === "codex-release-verifier") {
        return output(1);
      }
      if (command !== "claude-release-verifier") {
        return defaults.run(command, args, invocation);
      }
      const joined = args.join(" ");
      if (joined === "--version") return output(0, "verified-host 1.0.0");
      if (joined === "plugin marketplace list --json") {
        return output(
          0,
          marketplacePath
            ? [{ name: "vibehub", path: marketplacePath }]
            : [],
        );
      }
      if (
        args[0] === "plugin" &&
        args[1] === "marketplace" &&
        args[2] === "add"
      ) {
        marketplacePath = args[3];
        return output(0);
      }
      if (joined === "plugin list --json") {
        return output(
          0,
          installed
            ? [
                {
                  id: "vibehub@vibehub",
                  scope: "user",
                  version,
                  enabled: true,
                  installPath: fakeClaudeCache,
                },
              ]
            : [],
        );
      }
      if (
        args[0] === "plugin" &&
        (args[1] === "install" || args[1] === "update")
      ) {
        if (!marketplacePath) {
          return output(1, "marketplace was not registered");
        }
        rmSync(fakeClaudeCache, { recursive: true, force: true });
        cpSync(join(marketplacePath, "plugins", "vibehub"), fakeClaudeCache, {
          recursive: true,
        });
        installed = true;
        return output(0);
      }
      return output(1, `unexpected fake Claude command: ${joined}`);
    },
  };

  const receipt = installerModule.installVibeHubHosts(
    {
      hosts: ["claude"],
      version,
      repository: process.env.GITHUB_REPOSITORY ?? "VW-ai/vibehub-plugin",
      source: releaseSource,
      installDir,
      replaceExisting: false,
    },
    dependencies,
  );
  if (
    receipt.ok !== true ||
    receipt.version !== version ||
    receipt.distribution?.source !== "local" ||
    receipt.hosts?.claude?.version !== version
  ) {
    throw new Error(
      `private installer returned an incomplete receipt: ${JSON.stringify(receipt)}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      version,
      source: "authenticated private GitHub Release download",
      cli: cliArtifact.archive,
      claudeRegistration: "verified with isolated host double",
    })}\n`,
  );
} finally {
  if (process.env.VIBEHUB_KEEP_TMP === "1") {
    process.stderr.write(`kept private installer verification at ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
}
