#!/usr/bin/env node
/**
 * vibehub — thin CLI over @vibehub/core (decision-project-013: the CLI does
 * argument parsing and output formatting ONLY; every real operation is one
 * core call. Zero LLM, zero API keys.)
 *
 * Commands:
 *   vibehub hook <event>                              (M1 ③ — the heart)
 *   vibehub team sync    [--repo <path>] [--db <path>] [--json]
 *   vibehub team fixture [--repo <path>] [--db <path>] [--out <file>]
 *
 * `vibehub hook` reads the Claude Code hook payload from stdin, does one
 * short-lived pass (write event → claim injection queue → exit 0) and
 * NEVER fails the session: any error is swallowed to ~/.vibehub/hook.log.
 * DB override: --db or VIBEHUB_DB (hooks configs use env, not flags).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultDbPath,
  exportTeamMapFixture,
  GitFacade,
  ingestHookEvent,
  openDb,
  syncTeamSnapshot,
  type HookEventName,
  type HookPayload,
} from "@vibehub/core";

interface Flags {
  repo: string;
  db: string;
  out?: string;
  json: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { repo: process.cwd(), db: defaultDbPath(), json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") flags.repo = argv[++i] ?? flags.repo;
    else if (a === "--db") flags.db = argv[++i] ?? flags.db;
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--json") flags.json = true;
    else {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

const USAGE = `usage:
  vibehub hook <SessionStart|UserPromptSubmit|PostToolUse|Notification|Stop|SessionEnd>
  vibehub team sync    [--repo <path>] [--db <path>] [--json]
  vibehub team fixture [--repo <path>] [--db <path>] [--out <file>]`;

const HOOK_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
]);

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * The heart (decision-project-025). Exit 0 ALWAYS — a hook must never
 * break the user's session; failures go to ~/.vibehub/hook.log.
 */
function runHook(eventArg: string | undefined, rest: string[]): number {
  const flags = parseFlags(rest);
  const dbPath = process.env["VIBEHUB_DB"] ?? flags.db;
  try {
    const raw = readStdin();
    const payload = JSON.parse(raw) as HookPayload;
    const event = (eventArg ?? payload.hook_event_name) as HookEventName;
    if (!HOOK_EVENTS.has(event)) throw new Error(`unknown hook event: ${event}`);
    const db = openDb(dbPath);
    try {
      const result = ingestHookEvent(db, event, payload);
      if (result.output) console.log(JSON.stringify(result.output));
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      const logDir = path.join(os.homedir(), ".vibehub");
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(
        path.join(logDir, "hook.log"),
        `${new Date().toISOString()} ${eventArg ?? "?"} ${String(err)}\n`,
      );
    } catch {
      // even logging must not fail the session
    }
  }
  return 0;
}

function main(argv: string[]): number {
  const [group, cmd, ...rest] = argv;
  if (group === "hook") {
    return runHook(cmd, rest);
  }
  if (group !== "team" || !cmd) {
    console.error(USAGE);
    return 2;
  }
  const flags = parseFlags(rest);

  if (cmd === "sync") {
    const db = openDb(flags.db);
    const result = syncTeamSnapshot(db, flags.repo);
    db.close();
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const gh = result.ghAvailable
        ? `${result.prsMatched} PRs matched`
        : "gh unavailable — PR facts degraded (pure-git only)";
      const fetch =
        result.fetchOk === null
          ? "fetch skipped"
          : result.fetchOk
            ? "fetched"
            : "FETCH FAILED — snapshot is stale";
      console.log(
        `${result.repoRoot}: ${fetch}; ${result.branches} branches ` +
          `(${result.unmergedBranches} unmerged), ` +
          `${result.conflictPairs} conflict pair(s); ${gh}`,
      );
    }
    return 0;
  }

  if (cmd === "fixture") {
    const db = openDb(flags.db);
    const fixture = exportTeamMapFixture(db, GitFacade.resolveRepoRoot(flags.repo));
    db.close();
    const json = JSON.stringify(fixture, null, 2);
    if (flags.out) {
      fs.mkdirSync(path.dirname(flags.out), { recursive: true });
      fs.writeFileSync(flags.out, json + "\n");
      console.error(`wrote ${flags.out}`);
    } else {
      console.log(json);
    }
    return 0;
  }

  console.error(USAGE);
  return 2;
}

process.exit(main(process.argv.slice(2)));
