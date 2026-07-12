#!/usr/bin/env node
/**
 * vibehub — thin CLI over @vibehub/core (decision-project-013: the CLI does
 * argument parsing and output formatting ONLY; every real operation is one
 * core call. Zero LLM, zero API keys.)
 *
 * M1 ① commands (the team-visibility vertical slice):
 *   vibehub team sync    [--repo <path>] [--db <path>] [--json]
 *   vibehub team fixture [--repo <path>] [--db <path>] [--out <file>]
 *
 * `vibehub hook <event>` (the system's heart) lands in M1 ③.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultDbPath,
  exportTeamMapFixture,
  GitFacade,
  openDb,
  syncTeamSnapshot,
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
  vibehub team sync    [--repo <path>] [--db <path>] [--json]
  vibehub team fixture [--repo <path>] [--db <path>] [--out <file>]`;

function main(argv: string[]): number {
  const [group, cmd, ...rest] = argv;
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
