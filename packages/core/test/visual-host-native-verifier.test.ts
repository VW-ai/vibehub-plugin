import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const verifierPath = path.join(root, "scripts", "verify-visual-host-native.mjs");

describe("visual host native verifier contract", () => {
  it("is portable, bounded, shell-free, and wired into the root verification path", () => {
    const source = fs.readFileSync(verifierPath, "utf8");
    const rootPackage = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const hostPackage = JSON.parse(
      fs.readFileSync(path.join(root, "packages", "visual-host", "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(source).toContain('process.platform !== "darwin"');
    expect(source).toContain('process.arch !== "arm64"');
    expect(source).toContain("process.env.DEVELOPER_DIR");
    expect(source).toContain('"/usr/bin/xcrun"');
    expect(source).toContain('"/usr/bin/xcode-select"');
    expect(source).toContain("shell: false");
    expect(source).toContain("timeout: commandTimeoutMs");
    expect(source).toContain('runCargo(["fmt", "--", "--check"])');
    expect(source).toContain('runCargo(["test", "--target", "aarch64-apple-darwin"])');
    expect(source).toContain('runCargo(["check", "--target", "aarch64-apple-darwin"])');
    expect(rootPackage.scripts["verify:visual-host-native"]).toBe(
      "node scripts/verify-visual-host-native.mjs",
    );
    expect(rootPackage.scripts.verify).toContain("pnpm verify:visual-host-native");
    expect(hostPackage.scripts["native:check"]).not.toContain(
      "/Applications/Xcode.app",
    );
    expect(hostPackage.scripts["native:test"]).not.toContain(
      "/Applications/Xcode.app",
    );
    expect(hostPackage.scripts["native:build"]).not.toContain(
      "/Applications/Xcode.app",
    );
  });
});
