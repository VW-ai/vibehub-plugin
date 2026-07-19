import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/main.js";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["VIBEHUB_PLUGIN_ROOT"];
  delete process.env["VIBEHUB_ASSET_SOURCE"];
  delete process.env["VIBEHUB_STATE_DIR"];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(git = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-setup-cli-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const plugin = path.join(root, "plugin");
  const source = path.join(root, "release");
  fs.mkdirSync(repo);
  fs.mkdirSync(plugin);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "managed.txt"), "release\n");
  if (git) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  process.env["VIBEHUB_PLUGIN_ROOT"] = plugin;
  process.env["VIBEHUB_ASSET_SOURCE"] = source;
  process.env["VIBEHUB_STATE_DIR"] = path.join(root, "state");
  return { root, repo, db: path.join(root, "workbench.db") };
}
function invoke(argv: string[]): { exit: number; value: any } {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  return { exit: main(argv), value: JSON.parse(stdout) };
}
describe("vibehub setup CLI", () => {
  it("exposes inspect/apply/status as one stable JSON object with honest exit codes", () => {
    const x = fixture();
    expect(invoke(["setup", "inspect", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({ exit: 0, value: { schemaVersion: 1, command: "inspect", outcome: "changes_required" } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "status", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({ exit: 1, value: { command: "status", outcome: "waiting" } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "apply", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({ exit: 0, value: { command: "apply", outcome: "applied", ok: true } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "status", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({
        exit: 1,
        value: {
          command: "status",
          outcome: "waiting",
          activation: {
            connected: { state: "not_proven" },
            activated: { state: "not_proven" },
          },
        },
      });
  });
  it("returns exit 1 for non-git without creating DB and exit 2 for unknown/malformed flags", () => {
    const x = fixture(false);
    expect(invoke(["setup", "apply", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({ exit: 1, value: { outcome: "blocked", errors: [{ code: "not_git_repository" }] } });
    expect(fs.existsSync(x.db)).toBe(false);
    vi.restoreAllMocks();
    expect(invoke(["setup", "inspect", "--json", "--repo"]))
      .toMatchObject({ exit: 2, value: { outcome: "blocked", errors: [{ code: "validation_error" }] } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "inspect", "--json", "--out", "x"]))
      .toMatchObject({ exit: 2, value: { errors: [{ message: "unknown flag: --out" }] } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "bogus", "--json"]))
      .toMatchObject({ exit: 2, value: { error: { code: "validation_error", message: "unknown setup subcommand: bogus" } } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "--json"]))
      .toMatchObject({ exit: 2, value: { error: { message: "setup subcommand is required" } } });
    vi.restoreAllMocks();
    expect(invoke(["setup", "inspect", "--json", "--json"]))
      .toMatchObject({ exit: 2, value: { errors: [{ message: "repeated flag: --json" }] } });
  });
  it("uses usage stderr only for a missing non-JSON subcommand", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const write = vi.spyOn(process.stdout, "write");
    expect(main(["setup"])).toBe(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
  });
  it("normalizes release-manifest failures to the full setup result shape", () => {
    const x = fixture();
    process.env["VIBEHUB_ASSET_SOURCE"] = path.join(x.root, "missing-release");
    expect(invoke(["setup", "inspect", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({
        exit: 1,
        value: {
          schemaVersion: 1, command: "inspect", ok: false, outcome: "blocked",
          repo: { root: null, toplevel: null, status: "blocked" },
          instructions: [], runtime: null, init: null,
          activation: { installed: { state: "blocked" }, connected: { state: "blocked" }, activated: { state: "blocked" } },
          errors: [{ code: "runtime_failed" }],
        },
      });
  });
  it("rejects an empty release manifest before setup mutation", () => {
    const x = fixture();
    fs.rmSync(path.join(process.env["VIBEHUB_ASSET_SOURCE"]!, "managed.txt"));
    expect(invoke(["setup", "apply", "--json", "--repo", x.repo, "--db", x.db]))
      .toMatchObject({
        exit: 1,
        value: {
          command: "apply", ok: false, outcome: "blocked",
          instructions: [], runtime: null, init: null,
          errors: [{ code: "invalid_release_manifest" }],
        },
      });
    expect(fs.existsSync(x.db)).toBe(false);
    expect(fs.existsSync(path.join(x.repo, "AGENTS.md"))).toBe(false);
  });
});
