import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const tauriConfig = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
) as Record<string, unknown>;
const capability = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "capabilities", "corner.json"), "utf8"),
) as Record<string, unknown>;
const cargo = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
const nativeEntry = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
const workspacePackage = JSON.parse(
  fs.readFileSync(path.resolve(root, "..", "..", "package.json"), "utf8"),
) as { scripts: Record<string, string> };

describe("native host configuration", () => {
  it("pins the truthful arm64-first macOS application identity and hidden corner window", () => {
    expect(tauriConfig).toMatchObject({
      productName: "VibeHub",
      identifier: "ai.vibehub.visual",
      app: {
        windows: [{
          label: "corner",
          visible: false,
          focus: false,
          decorations: false,
          transparent: true,
          alwaysOnTop: true,
        }],
      },
      bundle: {
        targets: ["app"],
        macOS: { minimumSystemVersion: "14.0" },
      },
    });
  });

  it("uses a closed CSP and a single narrow window capability", () => {
    const serialized = JSON.stringify({ tauriConfig, capability, cargo });
    expect(capability).toMatchObject({
      identifier: "corner-capability",
      windows: ["corner"],
      permissions: ["core:window:allow-start-dragging"],
    });
    expect(serialized).not.toMatch(
      /https?:|localhost|shell:|opener:|fs:|process:|sql:|plugin-shell|plugin-sql/i,
    );
    expect(serialized).toContain("connect-src 'none'");
  });

  it("declares no bundled sidecar or external binary", () => {
    expect(JSON.stringify(tauriConfig)).not.toMatch(/externalBin|sidecar/i);
  });

  it("declares the macOS Accessory activation policy without claiming runtime proof", () => {
    expect(nativeEntry).toContain(
      "app.set_activation_policy(tauri::ActivationPolicy::Accessory)",
    );
  });

  it("does not silently discard show, hide, wake, or close-hide failures", () => {
    expect(nativeEntry).not.toMatch(/let _ = (show_corner|hide_corner|window\.hide)/);
    expect(nativeEntry).toContain("observe_handler_result");
  });

  it("uses the WCAG-contrast status ink for text signals", () => {
    expect(styles).toContain("--signal-text: #8f563f");
    expect(styles).toMatch(/\.availability-partial,[\s\S]*color: var\(--signal-text\)/u);
    expect(styles).toMatch(/\.freshness-stale \{[\s\S]*color: var\(--signal-text\)/u);
  });

  it.each(["build", "typecheck", "test"])(
    "includes the visual-host frontend in the root %s gate",
    (gate) => {
      expect(workspacePackage.scripts[gate]).toContain(
        `pnpm --filter @vibehub/visual-host ${gate}`,
      );
    },
  );
});
