#!/usr/bin/env node
// VibeHub template · plugin 0.8.0 · copied by vibehub-setup; keep with scripts/vh.mjs and contracts/
// One-way projection of VibeHub Tickets onto GitHub Issues.
//
// Git is the source of truth. This script reads .vibehub/tickets, outcomes,
// and evidence, computes the Issue each Ticket should be, compares with the
// remote, and applies only the difference. It never reads Issue content back
// into the repository and never commits. Mapping lives in a hidden marker in
// the Issue body; Evidence comments carry their own marker so reruns are
// idempotent.
//
//   node scripts/sync-github-issues.mjs --repo . --github VW-ai/vibehub-plugin [--dry-run]

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  loadRepository,
  ticketNextAction,
  ticketStatus,
} from "./scripts/vh.mjs";

export const TICKET_MARKER = "vibehub:ticket-id";
export const EVIDENCE_MARKER = "vibehub:evidence-id";

const STATE_LABELS = {
  DONE: { name: "state: done", color: "8250df", description: "Successful Outcome recorded" },
  EXECUTE: { name: "state: ready", color: "1f883d", description: "Executable now; acceptance Evidence incomplete" },
  CLOSE_OUT: { name: "state: close-out", color: "0969da", description: "Evidence complete; awaiting independent adjudication" },
  NEEDS_HUMAN: { name: "state: needs-human", color: "bf8700", description: "A human-authority criterion needs explicit human Evidence" },
  WAIT: { name: "state: blocked", color: "cf222e", description: "Waiting on direct prerequisites" },
  REFINE: { name: "state: refine", color: "6e7781", description: "Draft contract needs firm acceptance" },
  REPLAN: { name: "state: replan", color: "e16f24", description: "Non-successful Outcome; revise before the next cycle" },
};
const MATURITY_LABELS = {
  firm: { name: "maturity: firm", color: "d0d7de", description: "Acceptance is executable" },
  draft: { name: "maturity: draft", color: "f6f8fa", description: "Direction known; acceptance not yet firm" },
};
export const ALL_LABELS = [...Object.values(STATE_LABELS), ...Object.values(MATURITY_LABELS)];

// ---------- pure projection ----------

export function humanizeTicketId(ticketId) {
  const words = ticketId.replace(/^ticket-/, "").split("-");
  const fixed = { github: "GitHub", pr: "PR", ui: "UI", cli: "CLI", dsh: "DSH", api: "API", ci: "CI", v: "v" };
  return words
    .map((w, i) => {
      if (fixed[w]) return fixed[w];
      if (/^v\d/.test(w)) return w;
      if (/^pr\d+$/.test(w)) return `PR${w.slice(2)}`;
      return i === 0 ? w[0].toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}

function refLink(ref, github) {
  if (/^https?:\/\//.test(ref)) return ref;
  if (ref.startsWith("commit:")) return `\`${ref}\``;
  if (ref.startsWith("conversation:")) return `\`${ref}\``;
  return `[${ref}](https://github.com/${github}/blob/main/${ref})`;
}

function isoDate(value) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

export function renderIssueBody({ ticket, outcome, nextAction, status, numbers, github }) {
  const accepted = new Set(outcome?.accepted_acceptance_ids ?? []);
  const lines = [];
  lines.push(`<!-- ${TICKET_MARKER}=${ticket.ticket_id} -->`);
  lines.push(`> **Ticket** \`${ticket.ticket_id}\` · **${status}** · next: \`${nextAction.action}\` · maturity: ${ticket.maturity ?? "firm"}`);
  lines.push("");
  lines.push("## Outcome");
  lines.push("");
  lines.push(ticket.outcome);
  lines.push("");
  lines.push("## Acceptance");
  lines.push("");
  for (const c of ticket.acceptance) {
    const box = accepted.has(c.acceptance_id) ? "[x]" : "[ ]";
    const who = (c.authority ?? "agent") === "human" ? " 👤 human" : "";
    lines.push(`- ${box} **\`${c.acceptance_id}\`**${who} — ${c.criterion}`);
  }
  if (ticket.constraints?.length) {
    lines.push("");
    lines.push("## Constraints");
    lines.push("");
    for (const c of ticket.constraints) lines.push(`- ${c}`);
  }
  if (ticket.relations?.length) {
    lines.push("");
    lines.push("## Dependencies");
    lines.push("");
    for (const r of ticket.relations) {
      const n = numbers.get(r.target_ticket_id);
      const target = n ? `#${n}` : `\`${r.target_ticket_id}\``;
      lines.push(`- Blocked by ${target}${r.rationale ? ` — ${r.rationale}` : ""}`);
    }
  }
  if (ticket.context_refs?.length) {
    lines.push("");
    lines.push("## Context");
    lines.push("");
    for (const ref of ticket.context_refs) lines.push(`- ${refLink(ref.ref, github)} — ${ref.purpose}`);
  }
  if (ticket.deliveries?.length) {
    lines.push("");
    lines.push("## Deliveries");
    lines.push("");
    for (const d of ticket.deliveries) lines.push(`- ${refLink(d.ref, github)} · ${d.state}`);
  }
  if (outcome) {
    lines.push("");
    lines.push(`## Outcome record · ${outcome.status}`);
    lines.push("");
    lines.push(`Closed ${isoDate(outcome.closed_at)}. ${outcome.summary}`);
    if (outcome.unresolved_acceptance_ids?.length) {
      lines.push("");
      lines.push(`Unresolved: ${outcome.unresolved_acceptance_ids.map((id) => `\`${id}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push(`<sub>Projected from [\`.vibehub/tickets/${ticket.ticket_id}.yaml\`](https://github.com/${github}/blob/main/.vibehub/tickets/${ticket.ticket_id}.yaml) on \`main\`. Git is the source of truth; this Issue is a read-only mirror and comments here are discussion only.</sub>`);
  return lines.join("\n");
}

export function renderEvidenceComment(evidence, github) {
  const lines = [];
  lines.push(`<!-- ${EVIDENCE_MARKER}=${evidence.evidence_id} -->`);
  lines.push(`**Evidence** \`${evidence.evidence_id}\` · ${isoDate(evidence.recorded_at)} · origin: ${evidence.origin ?? "agent"}`);
  lines.push("");
  lines.push(`Accepts: ${evidence.acceptance_ids.map((id) => `\`${id}\``).join(", ")}`);
  lines.push("");
  lines.push(evidence.summary);
  if (evidence.refs?.length) {
    lines.push("");
    for (const ref of evidence.refs) lines.push(`- ${refLink(ref, github)}`);
  }
  return lines.join("\n");
}

/** Desired state for every Ticket, independent of Issue numbers. */
export function computeProjection(repoRoot, github) {
  const repository = loadRepository(repoRoot);
  assertValid(repository.errors);
  const evidenceByTicket = new Map();
  for (const { document } of repository.evidence.documents.values()) {
    if (!evidenceByTicket.has(document.ticket_id)) evidenceByTicket.set(document.ticket_id, []);
    evidenceByTicket.get(document.ticket_id).push(document);
  }
  const items = [];
  for (const { document: ticket } of repository.tickets.documents.values()) {
    const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null;
    const nextAction = ticketNextAction(repository, ticket);
    const status = ticketStatus(repository, ticket);
    const evidence = (evidenceByTicket.get(ticket.ticket_id) ?? [])
      .slice()
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.evidence_id.localeCompare(b.evidence_id));
    items.push({
      ticket_id: ticket.ticket_id,
      title: humanizeTicketId(ticket.ticket_id),
      state: status === "DONE" ? "closed" : "open",
      labels: [STATE_LABELS[nextAction.action].name, MATURITY_LABELS[ticket.maturity ?? "firm"].name],
      comments: evidence.map((e) => ({ evidence_id: e.evidence_id, body: renderEvidenceComment(e, github) })),
      depends_on: (ticket.relations ?? []).map((r) => r.target_ticket_id),
      renderBody: (numbers) => renderIssueBody({ ticket, outcome, nextAction, status, numbers, github }),
    });
  }
  items.sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
  return items;
}

export function markerValue(text, marker) {
  const match = String(text ?? "").match(new RegExp(`<!--\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([a-z0-9-]+)\\s*-->`));
  return match ? match[1] : null;
}

function normalize(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trimEnd();
}

/**
 * Diff desired projection against remote Issues.
 * remote: [{ number, title, body, state: "OPEN"|"CLOSED", labels: [name], comments: [{ body }] }]
 * Returns { creates: [item], ops: [...] } where ops need Issue numbers that may
 * only exist after creates are applied (see sync()).
 */
export function planSync(projection, remote) {
  const byTicket = new Map();
  for (const issue of remote) {
    const id = markerValue(issue.body, TICKET_MARKER);
    if (id && !byTicket.has(id)) byTicket.set(id, issue);
  }
  const creates = projection.filter((item) => !byTicket.has(item.ticket_id));
  return { byTicket, creates };
}

export function planUpdates(projection, byTicket) {
  const numbers = new Map([...byTicket].map(([id, issue]) => [id, issue.number]));
  const ops = [];
  for (const item of projection) {
    const issue = byTicket.get(item.ticket_id);
    if (!issue) continue;
    const body = item.renderBody(numbers);
    const labelsNow = new Set((issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)));
    const managed = new Set(ALL_LABELS.map((l) => l.name));
    const addLabels = item.labels.filter((l) => !labelsNow.has(l));
    const removeLabels = [...labelsNow].filter((l) => managed.has(l) && !item.labels.includes(l));
    if (normalize(issue.title) !== item.title || normalize(issue.body) !== normalize(body) || addLabels.length || removeLabels.length) {
      ops.push({ kind: "update", number: issue.number, ticket_id: item.ticket_id, title: item.title, body, addLabels, removeLabels });
    }
    const seen = new Set((issue.comments ?? []).map((c) => markerValue(c.body, EVIDENCE_MARKER)).filter(Boolean));
    for (const comment of item.comments) {
      if (!seen.has(comment.evidence_id)) {
        ops.push({ kind: "comment", number: issue.number, ticket_id: item.ticket_id, evidence_id: comment.evidence_id, body: comment.body });
      }
    }
    const remoteState = String(issue.state).toLowerCase();
    if (remoteState !== item.state) {
      ops.push({ kind: item.state === "closed" ? "close" : "reopen", number: issue.number, ticket_id: item.ticket_id });
    }
  }
  return ops;
}

/**
 * Diff desired native blocked_by relationships against remote ones.
 * remoteDeps: Map<issueNumber, number[]> (current blockers per mirrored Issue).
 * Only relationships between two mirrored Issues are managed; a blocker that is
 * not a mirrored Ticket Issue is left untouched.
 */
export function planDependencies(projection, byTicket, remoteDeps) {
  const numbers = new Map([...byTicket].map(([id, issue]) => [id, issue.number]));
  const mirrored = new Set(numbers.values());
  const ops = [];
  for (const item of projection) {
    const number = numbers.get(item.ticket_id);
    if (!number) continue;
    const desired = new Set(item.depends_on.map((id) => numbers.get(id)).filter(Boolean));
    const current = new Set(remoteDeps.get(number) ?? []);
    for (const blocker of [...desired].sort((a, b) => a - b)) {
      if (!current.has(blocker)) ops.push({ kind: "dep-add", number, ticket_id: item.ticket_id, blocker });
    }
    for (const blocker of [...current].sort((a, b) => a - b)) {
      if (!desired.has(blocker) && mirrored.has(blocker)) ops.push({ kind: "dep-remove", number, ticket_id: item.ticket_id, blocker });
    }
  }
  return ops;
}

// ---------- gh adapter ----------

function gh(args, { input } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function fetchRemoteIssues(github) {
  const out = gh([
    "issue", "list", "-R", github, "--state", "all", "--limit", "1000",
    "--json", "number,title,body,state,labels,comments",
  ]);
  return JSON.parse(out);
}

function fetchRemoteDependencies(github, numbers) {
  const deps = new Map();
  for (const number of numbers) {
    const out = gh(["api", `repos/${github}/issues/${number}/dependencies/blocked_by`, "--paginate"]);
    deps.set(number, JSON.parse(out).map((issue) => issue.number));
  }
  return deps;
}

const databaseIds = new Map();
function issueDatabaseId(github, number) {
  if (!databaseIds.has(number)) {
    databaseIds.set(number, JSON.parse(gh(["api", `repos/${github}/issues/${number}`])).id);
  }
  return databaseIds.get(number);
}

function ensureLabels(github, dryRun, log) {
  for (const label of ALL_LABELS) {
    log(`label  ensure "${label.name}"`);
    if (!dryRun) gh(["label", "create", label.name, "-R", github, "--color", label.color, "--description", label.description, "--force"]);
  }
}

export async function sync({ repoRoot, github, dryRun, log = console.log, writeDelayMs = 1000 }) {
  const projection = computeProjection(repoRoot, github);
  const remote = fetchRemoteIssues(github);
  log(`${projection.length} tickets on disk, ${remote.length} issues on ${github}`);
  ensureLabels(github, dryRun, log);

  const { byTicket, creates } = planSync(projection, remote);
  const wait = async () => { if (!dryRun) await sleep(writeDelayMs); };

  // Pass 1: create missing Issues with a provisional body so every Ticket has
  // a number before dependency links are rendered.
  for (const item of creates) {
    log(`create ${item.ticket_id} → "${item.title}"`);
    if (dryRun) {
      byTicket.set(item.ticket_id, { number: null, title: item.title, body: "", state: "OPEN", labels: [], comments: [] });
      continue;
    }
    const url = gh([
      "issue", "create", "-R", github, "--title", item.title,
      "--body", `<!-- ${TICKET_MARKER}=${item.ticket_id} -->\nProvisioning…`,
      ...item.labels.flatMap((l) => ["--label", l]),
    ]).trim();
    const number = Number(url.split("/").pop());
    byTicket.set(item.ticket_id, { number, title: item.title, body: "", state: "OPEN", labels: item.labels, comments: [] });
    await wait();
  }

  // Pass 2: bring every Issue to its desired body, labels, comments, state.
  const ops = planUpdates(projection, byTicket);
  for (const op of ops) {
    const ref = op.number ? `#${op.number}` : `(new)`;
    if (op.kind === "update") {
      log(`update ${ref} ${op.ticket_id}${op.addLabels.length ? ` +[${op.addLabels}]` : ""}${op.removeLabels.length ? ` -[${op.removeLabels}]` : ""}`);
      if (!dryRun) {
        gh([
          "issue", "edit", String(op.number), "-R", github, "--title", op.title, "--body", op.body,
          ...op.addLabels.flatMap((l) => ["--add-label", l]),
          ...op.removeLabels.flatMap((l) => ["--remove-label", l]),
        ]);
        await wait();
      }
    } else if (op.kind === "comment") {
      log(`comment ${ref} ${op.ticket_id} evidence ${op.evidence_id}`);
      if (!dryRun) { gh(["issue", "comment", String(op.number), "-R", github, "--body", op.body]); await wait(); }
    } else {
      log(`${op.kind.padEnd(6)} ${ref} ${op.ticket_id}`);
      if (!dryRun) { gh(["issue", op.kind, String(op.number), "-R", github]); await wait(); }
    }
  }

  // Pass 3: native blocked_by relationships between mirrored Issues.
  const existingNumbers = [...byTicket.values()].map((i) => i.number).filter(Boolean);
  const remoteDeps = fetchRemoteDependencies(github, existingNumbers);
  const depOps = planDependencies(projection, byTicket, remoteDeps);
  for (const op of depOps) {
    const ref = op.number ? `#${op.number}` : "(new)";
    log(`${op.kind === "dep-add" ? "dep+  " : "dep-  "} ${ref} ${op.ticket_id} blocked by #${op.blocker}`);
    if (dryRun) continue;
    if (op.kind === "dep-add") {
      gh(["api", "-X", "POST", `repos/${github}/issues/${op.number}/dependencies/blocked_by`, "-F", `issue_id=${issueDatabaseId(github, op.blocker)}`]);
    } else {
      gh(["api", "-X", "DELETE", `repos/${github}/issues/${op.number}/dependencies/blocked_by/${issueDatabaseId(github, op.blocker)}`]);
    }
    await wait();
  }
  log(`${dryRun ? "dry-run: would apply" : "applied"} ${creates.length} creates, ${ops.length} follow-up operations, ${depOps.length} dependency changes`);
  return { creates: creates.length, ops: ops.length, deps: depOps.length };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { repo: process.cwd(), github: null, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--repo") args.repo = resolve(argv[++i]);
    else if (a === "--github") args.github = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!args.github) {
    const pkg = join(args.repo, "package.json");
    if (existsSync(pkg)) {
      const url = JSON.parse(readFileSync(pkg, "utf8")).repository?.url ?? "";
      const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (m) args.github = m[1];
    }
  }
  if (!args.github) throw new Error("--github owner/repo is required");
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  sync({ repoRoot: args.repo, github: args.github, dryRun: args.dryRun }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
