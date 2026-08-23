import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const root = resolve(new URL("..", import.meta.url).pathname);
export const helper = join(root, "skills", "vibehub-core", "scripts", "vh.mjs");

export function tempRepo(label) {
  return mkdtempSync(join(tmpdir(), `vibehub-${label}-`));
}

export function run(repo, domain, operation, input, flags = []) {
  let inputPath;
  if (input !== undefined) {
    inputPath = join(repo, `.input-${domain}-${operation}-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  }
  const args = [helper, domain, operation, "--repo", repo, ...flags];
  if (inputPath) args.push("--input", inputPath);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const envelope = JSON.parse(result.stdout);
  return { ...result, envelope };
}

export function context(overrides = {}) {
  return {
    schema_version: 1,
    kind: "context",
    context_id: "decision-use-tickets",
    type: "decision",
    state: "active",
    summary: "Use Tickets as the development entry point",
    detail: "Durable product work starts from a Ticket; Context remains the supporting memory layer.",
    tags: ["tickets", "context"],
    source: {
      ref: "conversation:2026-07-31",
      quote: "用 ticket system 来主导开发",
      captured_at: "2026-07-31T22:00:00.000Z"
    },
    evidence: [
      {
        ref: "conversation:2026-07-31",
        note: "Repository owner explicitly selected the Ticket-first product direction."
      }
    ],
    relations: [],
    ...overrides,
  };
}

export function room(id, overrides = {}) {
  return {
    schema_version: 1,
    kind: "room",
    room_id: id,
    description: `The ${id} room.`,
    boundary: `Everything about ${id}, nothing else.`,
    anchors: [`src/${id}/`],
    stale: false,
    ...overrides,
  };
}

export function writeRoom(repo, roomPath, document) {
  const directory = join(repo, ".vibehub", "rooms", ...roomPath.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "room.yaml"), `${JSON.stringify(document, null, 2)}\n`);
}

export function ticket(id, dependencies = []) {
  return {
    schema_version: 2,
    kind: "ticket",
    ticket_id: id,
    outcome: `${id} observable outcome`,
    deliveries: [],
    context: `Execute ${id} from its checked-in context.`,
    acceptance: [
      { acceptance_id: "works", criterion: `${id} behavior is observed.` },
    ],
    constraints: ["Keep the change bounded."],
    context_refs: [],
    relations: dependencies.map((target_ticket_id) => ({
      type: "depends_on",
      target_ticket_id,
      rationale: `${id} needs ${target_ticket_id}.`,
    })),
    provenance_refs: ["test:ticket-vertical-slice"],
  };
}
