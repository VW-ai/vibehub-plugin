import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestHookEvent, openDb } from "@vibehub/core";
import { main } from "../src/main.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["VIBEHUB_PLUGIN_ROOT"];
  delete process.env["VIBEHUB_ASSET_SOURCE"];
  delete process.env["VIBEHUB_STATE_DIR"];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vh-receipt-cli-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const plugin = path.join(root, "plugin");
  const source = path.join(root, "release");
  fs.mkdirSync(repo);
  fs.mkdirSync(plugin);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "managed.txt"), "release\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  process.env["VIBEHUB_PLUGIN_ROOT"] = plugin;
  process.env["VIBEHUB_ASSET_SOURCE"] = source;
  process.env["VIBEHUB_STATE_DIR"] = path.join(root, "state");
  return { root, repo, plugin, db: path.join(root, "workbench.db") };
}

function capture(argv: string[]): { exit: number; out: string } {
  let out = "";
  vi.spyOn(console, "log").mockImplementation((chunk: unknown) => { out += `${String(chunk)}\n`; });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = main(argv);
  vi.restoreAllMocks();
  return { exit, out };
}

const LABELS = ["Activity:", "Trigger:", "Effects:", "Result:", "Next:"];

describe("human CLI surfaces render the shared workflow receipt", () => {
  it("renders init success as a five-section persisted setup receipt", () => {
    const x = fixture();
    const { exit, out } = capture(["init", "--repo", x.repo, "--db", x.db]);
    expect(exit).toBe(0);
    for (const label of LABELS) expect(out).toContain(label);
    expect(out).toContain("setup");
    expect(out).toContain("persisted");
    // Portable text: readable with no ANSI and no control characters
    // (newlines excepted - they separate the sections).
    expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f]/);
  });

  it("renders init conflicts as an honest waiting receipt with a required next action", () => {
    const x = fixture();
    // A pre-existing unmanaged file at a managed target is a conflict.
    fs.writeFileSync(path.join(x.plugin, "managed.txt"), "user content\n");
    const { exit, out } = capture(["init", "--repo", x.repo, "--db", x.db]);
    expect(exit).toBe(1);
    expect(out).toContain("Result:");
    expect(out).toContain("waiting");
    expect(out).not.toContain("persisted");
    expect(out).toContain("required");
  });

  it("renders doctor verified/failed honestly and keeps --json machine output raw", () => {
    const x = fixture();
    const unhealthy = capture(["doctor", "--repo", x.repo, "--db", x.db]);
    expect(unhealthy.exit).toBe(1);
    expect(unhealthy.out).toContain("failed");
    expect(unhealthy.out).not.toContain("verified");
    for (const label of LABELS) expect(unhealthy.out).toContain(label);

    expect(capture(["init", "--json", "--repo", x.repo, "--db", x.db]).exit).toBe(0);
    const healthy = capture(["doctor", "--repo", x.repo, "--db", x.db]);
    expect(healthy.exit).toBe(0);
    expect(healthy.out).toContain("verified");
    expect(healthy.out).toContain("health_check");

    const machine = capture(["doctor", "--json", "--repo", x.repo, "--db", x.db]);
    expect(machine.exit).toBe(0);
    const parsed = JSON.parse(machine.out) as { healthy: boolean };
    expect(parsed.healthy).toBe(true);
    expect(machine.out).not.toContain("Activity:");
  });

  it("keeps the setup subcommand one-liner untouched (skill owns setup presentation)", () => {
    const x = fixture();
    const { exit, out } = capture(["setup", "inspect", "--repo", x.repo, "--db", x.db]);
    expect(exit).toBe(0);
    expect(out.trim()).toBe("inspect: changes_required");
    expect(out).not.toContain("Activity:");
  });

  it("routes terminal inject through the request ledger and renders a queued receipt", () => {
    const x = fixture();
    execFileSync("git", ["config", "user.name", "Test"], { cwd: x.repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: x.repo });
    fs.writeFileSync(path.join(x.repo, "README.md"), "seed\n");
    execFileSync("git", ["add", "README.md"], { cwd: x.repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: x.repo });
    const db = openDb(x.db);
    const started = ingestHookEvent(db, "SessionStart", { session_id: "cli-receipt", cwd: x.repo });
    db.close();

    const human = capture(["inject", started.taskId, "Skip the legacy path.", "--db", x.db, "--request", "cli-r1"]);
    expect(human.exit).toBe(0);
    for (const label of LABELS) expect(human.out).toContain(label);
    expect(human.out).toContain("queued");
    expect(human.out).toContain("applied");
    expect(human.out).toContain("inject");

    const machine = capture(["inject", started.taskId, "Second note.", "--db", x.db, "--request", "cli-r2", "--json"]);
    expect(machine.exit).toBe(0);
    const parsed = JSON.parse(machine.out) as { outcome: string; injectionIds: number[] };
    expect(parsed.outcome).toBe("applied");
    expect(parsed.injectionIds).toHaveLength(1);
    expect(machine.out).not.toContain("Activity:");

    const replay = capture(["inject", started.taskId, "Second note.", "--db", x.db, "--request", "cli-r2", "--json"]);
    expect(replay.exit).toBe(0);
    expect((JSON.parse(replay.out) as { replayed?: boolean }).replayed).toBe(true);

    const unknown = capture(["inject", "task:missing", "note", "--db", x.db]);
    expect(unknown.exit).toBe(2);
  });

  it("renders a stale inject as an honest skipped receipt with no success copy", () => {
    const x = fixture();
    execFileSync("git", ["config", "user.name", "Test"], { cwd: x.repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: x.repo });
    fs.writeFileSync(path.join(x.repo, "README.md"), "seed\n");
    execFileSync("git", ["add", "README.md"], { cwd: x.repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: x.repo });
    const db = openDb(x.db);
    const started = ingestHookEvent(db, "SessionStart", { session_id: "cli-stale", cwd: x.repo });
    ingestHookEvent(db, "SessionEnd", { session_id: "cli-stale", cwd: x.repo, reason: "exit" });
    db.close();

    const { exit, out } = capture(["inject", started.taskId, "Too late.", "--db", x.db]);
    expect(exit).toBe(1);
    for (const label of LABELS) expect(out).toContain(label);
    expect(out).toContain("skipped");
    expect(out).toContain("stale");
    const trigger = out.split("\n").find((line) => line.startsWith("Trigger:")) ?? "";
    expect(trigger).toContain("requested");
    expect(trigger).not.toMatch(/queued|applied/i);
  });

  it("renders an already-waiting pause as requested and skipped, never queued", () => {
    const x = fixture();
    execFileSync("git", ["config", "user.name", "Test"], { cwd: x.repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: x.repo });
    fs.writeFileSync(path.join(x.repo, "README.md"), "seed\n");
    execFileSync("git", ["add", "README.md"], { cwd: x.repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: x.repo });
    const db = openDb(x.db);
    const started = ingestHookEvent(db, "SessionStart", { session_id: "cli-no-op", cwd: x.repo });
    db.prepare("UPDATE tasks SET state = 'waiting' WHERE id = ?").run(started.taskId);
    db.close();

    const { exit, out } = capture([
      "inject", started.taskId, "Pause now.", "--mode", "pause",
      "--db", x.db, "--request", "cli-no-op-r1",
    ]);
    expect(exit).toBe(1);
    for (const label of LABELS) expect(out).toContain(label);
    expect(out).toContain("skipped");
    expect(out).toContain("no_op");
    const trigger = out.split("\n").find((line) => line.startsWith("Trigger:")) ?? "";
    expect(trigger).toContain("requested");
    expect(trigger).not.toMatch(/queued|applied/i);
  });
});
