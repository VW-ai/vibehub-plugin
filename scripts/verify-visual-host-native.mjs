#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = path.join(root, "packages", "visual-host", "src-tauri");
const commandTimeoutMs = 180_000;
const discoveryTimeoutMs = 5_000;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.log(
    `SKIP visual host native verification: requires darwin/arm64, received ${process.platform}/${process.arch}.`,
  );
  process.exit(0);
}

function capture(executable, args) {
  return spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    shell: false,
    timeout: discoveryTimeoutMs,
  });
}

function discoverDeveloperDirectory() {
  if (process.env.DEVELOPER_DIR) return process.env.DEVELOPER_DIR;

  const xcrun = capture("/usr/bin/xcrun", ["--find", "xcodebuild"]);
  if (xcrun.status === 0) {
    const xcodebuild = xcrun.stdout.trim();
    const suffix = path.join("usr", "bin", "xcodebuild");
    if (xcodebuild.endsWith(suffix)) {
      const discovered = xcodebuild.slice(0, -suffix.length).replace(/\/$/, "");
      if (
        discovered.includes(".app/Contents/Developer")
        && fs.existsSync(discovered)
      ) {
        return discovered;
      }
    }
  }

  const selected = capture("/usr/bin/xcode-select", ["-p"]);
  if (selected.status === 0) {
    const developerDirectory = selected.stdout.trim();
    if (
      developerDirectory.includes(".app/Contents/Developer")
      && fs.existsSync(developerDirectory)
    ) {
      return developerDirectory;
    }
  }

  const conventional = "/Applications/Xcode.app/Contents/Developer";
  if (fs.existsSync(conventional)) return conventional;
  throw new Error(
    "Full Xcode is required. Set DEVELOPER_DIR or select Xcode with xcode-select.",
  );
}

const env = {
  ...process.env,
  DEVELOPER_DIR: discoverDeveloperDirectory(),
};

function runCargo(args) {
  const result = spawnSync("cargo", args, {
    cwd: nativeRoot,
    env,
    stdio: "inherit",
    shell: false,
    timeout: commandTimeoutMs,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal
      ? `terminated by ${result.signal}`
      : `exited with status ${String(result.status)}`;
    throw new Error(`cargo ${args.join(" ")} ${detail}`);
  }
}

runCargo(["fmt", "--", "--check"]);
runCargo(["test", "--target", "aarch64-apple-darwin"]);
runCargo(["check", "--target", "aarch64-apple-darwin"]);
console.log(`Verified visual host native target with DEVELOPER_DIR=${env.DEVELOPER_DIR}`);
