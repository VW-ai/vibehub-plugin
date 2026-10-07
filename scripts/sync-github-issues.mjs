#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  currentOutcome,
  loadRepository,
  ticketStatus,
} from "../skills/vibehub-core/scripts/vh.mjs";

export const TICKET_MARKER = "vibehub:ticket-id";
export const EVIDENCE_MARKER = "vibehub:evidence-id";

const STATE_LABELS = {
  DONE: { name: "state: done", color: "8250df", description: "Task recorded as done" },
  OPEN: { name: "state: open", color: "1f883d", description: "Open task with no unfinished prerequisites" },
  IN_PROGRESS: { name: "state: in-progress", color: "0969da", description: "Task recorded as in progress" },
  BLOCKED: { name: "state: blocked", color: "cf222e", description: "Open task with unfinished prerequisites" },
};
export const ALL_LABELS = Object.values(STATE_LABELS);
const RETIRED_LABELS = ["state: ready", "state: close-out", "state: needs-human", "state: refine", "state: replan", "maturity: firm", "maturity: draft"];

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

function refLink(ref, github, branch = "main") {
  if (/^https?:\/\//.test(ref)) return ref;
  const versioned = ref.match(/^commit:([0-9a-f]{40}):(.+)$/);
  if (versioned) return `[${ref}](https://github.com/${github}/blob/${versioned[1]}/${versioned[2]})`;
  if (ref.startsWith("commit:")) return `\`${ref}\``;
  if (ref.startsWith("conversation:")) return `\`${ref}\``;
  return `[${ref}](https://github.com/${github}/blob/${branch}/${ref})`;
}

function isoDate(value) {
  return typeof value === "string" ? value.slice(0, 10) : "";
}

export function renderIssueBody({ ticket, outcome, status, numbers, github, branch = "main" }) {
  const lines = [];
  lines.push(`<!-- ${TICKET_MARKER}=${ticket.ticket_id} -->`);
  lines.push(`> **Ticket** \`${ticket.ticket_id}\` · **${status}**`);
  lines.push("");
  lines.push("## Outcome");
  lines.push("");
  lines.push(ticket.outcome);
  if (ticket.context?.trim()) lines.push("", "## Background", "", ticket.context);
  const acceptance = (ticket.acceptance ?? []).filter((item) => item.state !== "retired");
  if (acceptance.length) lines.push("", "## Acceptance", "");
  for (const c of acceptance) {
    const who = (c.authority ?? "agent") === "human" ? " 👤 human" : "";
    lines.push(`- **\`${c.acceptance_id}\`**${who} — ${c.criterion}`);
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
    for (const ref of ticket.context_refs) lines.push(`- ${refLink(ref.ref, github, branch)} — ${ref.purpose}`);
  }
  if (ticket.deliveries?.length) {
    lines.push("");
    lines.push("## Deliveries");
    lines.push("");
    for (const d of ticket.deliveries) lines.push(`- ${refLink(d.ref, github, branch)} · ${d.state}`);
  }
  if (ticket.updates?.length) {
    lines.push("", "## Progress and results", "");
    for (const update of ticket.updates) {
      lines.push(`- ${isoDate(update.recorded_at)}${update.status ? ` · ${update.status}` : ""}: ${update.summary}`);
      for (const ref of update.refs ?? []) lines.push(`  - ${refLink(ref, github, branch)}`);
    }
  }
  if (outcome) {
    lines.push("");
    lines.push(`## Historical Outcome · ${outcome.status}`);
    lines.push("");
    lines.push(`Closed ${isoDate(outcome.closed_at)}. ${outcome.summary}`);
    if (outcome.unresolved_acceptance_ids?.length) {
      lines.push("");
      lines.push(`Unresolved: ${outcome.unresolved_acceptance_ids.map((id) => `\`${id}\``).join(", ")}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push(`<sub>Projected from [\`.vibehub/tickets/${ticket.ticket_id}.yaml\`](https://github.com/${github}/blob/${branch}/.vibehub/tickets/${ticket.ticket_id}.yaml) on \`${branch}\`. Git is the source of truth; this Issue is a read-only mirror and comments here are discussion only.</sub>`);
  return lines.join("\n");
}

export function renderEvidenceComment(evidence, github, branch = "main") {
  const lines = [];
  lines.push(`<!-- ${EVIDENCE_MARKER}=${evidence.evidence_id} -->`);
  lines.push(`**Evidence** \`${evidence.evidence_id}\` · ${isoDate(evidence.recorded_at)} · origin: ${evidence.origin ?? "agent"}`);
  lines.push("");
  lines.push(`Accepts: ${evidence.acceptance_ids.map((id) => `\`${id}\``).join(", ")}`);
  lines.push("");
  lines.push(evidence.summary);
  if (evidence.refs?.length) {
    lines.push("");
    for (const ref of evidence.refs) lines.push(`- ${refLink(ref, github, branch)}`);
  }
  return lines.join("\n");
}

/** Desired state for every Ticket, independent of Issue numbers. */
export function computeProjection(repoRoot, github, branch = "main") {
  const repository = loadRepository(repoRoot);
  assertValid(repository.errors);
  const evidenceByTicket = new Map();
  for (const { document } of repository.evidence.documents.values()) {
    if (!evidenceByTicket.has(document.ticket_id)) evidenceByTicket.set(document.ticket_id, []);
    evidenceByTicket.get(document.ticket_id).push(document);
  }
  const items = [];
  for (const { document: ticket } of repository.tickets.documents.values()) {
    const outcome = currentOutcome(repository, ticket);
    const status = ticketStatus(repository, ticket);
    const evidence = (evidenceByTicket.get(ticket.ticket_id) ?? [])
      .slice()
      .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.evidence_id.localeCompare(b.evidence_id));
    items.push({
      ticket_id: ticket.ticket_id,
      title: humanizeTicketId(ticket.ticket_id),
      state: status === "DONE" ? "closed" : "open",
      labels: [STATE_LABELS[status].name],
      comments: evidence.map((e) => ({ evidence_id: e.evidence_id, body: renderEvidenceComment(e, github, branch) })),
      depends_on: (ticket.relations ?? []).map((r) => r.target_ticket_id),
      renderBody: (numbers) => renderIssueBody({ ticket, outcome, status, numbers, github, branch }),
    });
  }
  items.sort((a, b) => a.ticket_id.localeCompare(b.ticket_id));
  return items;
}

export function markerValue(text, marker) {
  const header = String(text ?? "").split("\n", 1)[0];
  const match = header.match(new RegExp(`^<!--\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=([a-z0-9-]+)\\s*-->\\s*$`));
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
    if (!id) continue;
    if (byTicket.has(id)) throw new Error(`Duplicate Ticket marker ${id} on Issues #${byTicket.get(id).number} and #${issue.number}`);
    byTicket.set(id, issue);
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
    const labelNames = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
    const labelsNow = new Set(labelNames.map((name) => name.toLowerCase()));
    const managed = new Set([...ALL_LABELS.map((l) => l.name), ...RETIRED_LABELS]);
    const addLabels = item.labels.filter((l) => !labelsNow.has(l));
    const removeLabels = labelNames.filter((name) => managed.has(name.toLowerCase()) && !item.labels.includes(name.toLowerCase()));
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

function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) {
    throw new Error(`${program} ${args.slice(0, 3).join(" ")} failed: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function ghJson(endpoint, { method = "GET", body, pages = false } = {}) {
  const args = ["api", endpoint, "--method", method];
  if (pages) args.push("--paginate", "--slurp");
  if (body !== undefined) args.push("--input", "-");
  const value = JSON.parse(command("gh", args, { input: body === undefined ? undefined : JSON.stringify(body) }));
  if (!pages) return value;
  if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error(`Expected complete array pages from ${endpoint}`);
  return value.flat();
}

function canonicalHead(github) {
  const metadata = ghJson(`repos/${github}`);
  if (typeof metadata.default_branch !== "string" || !metadata.default_branch) throw new Error("GitHub did not return a default branch");
  const branch = metadata.default_branch;
  const ref = ghJson(`repos/${github}/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`);
  if (!/^[0-9a-f]{40}$/.test(ref.object?.sha ?? "")) throw new Error("GitHub did not return a canonical branch commit");
  return { branch, sha: ref.object.sha };
}

export function fetchRemoteIssues(github) {
  return ghJson(`repos/${github}/issues?state=all&per_page=100`, { pages: true })
    .filter((issue) => !issue.pull_request);
}

function readRemote(github) {
  const issues = fetchRemoteIssues(github);
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue.number) || !Number.isSafeInteger(issue.id)
      || !["open", "closed"].includes(issue.state) || !Array.isArray(issue.labels)) {
      throw new Error("Malformed GitHub Issue response");
    }
  }
  const { byTicket } = planSync([], issues);
  const commentsByIssue = new Map();
  if ([...byTicket.values()].some((issue) => issue.comments !== 0)) {
    const comments = ghJson(`repos/${github}/issues/comments?per_page=100`, { pages: true });
    for (const comment of comments) {
      const number = Number(comment.issue_url?.match(/\/issues\/([1-9]\d*)$/)?.[1]);
      if (!Number.isSafeInteger(number)) throw new Error("Malformed GitHub comment Issue URL");
      if (!commentsByIssue.has(number)) commentsByIssue.set(number, []);
      commentsByIssue.get(number).push(comment);
    }
  }
  const deps = new Map();
  for (const issue of byTicket.values()) {
    issue.comments = commentsByIssue.get(issue.number) ?? [];
    const seen = new Set();
    for (const comment of issue.comments) {
      const id = markerValue(comment.body, EVIDENCE_MARKER);
      if (id && seen.has(id)) throw new Error(`Duplicate Evidence marker ${id} on Issue #${issue.number}`);
      if (id) seen.add(id);
    }
    const blockers = issue.issue_dependencies_summary?.total_blocked_by === 0 ? []
      : ghJson(`repos/${github}/issues/${issue.number}/dependencies/blocked_by?per_page=100`, { pages: true });
    deps.set(issue.number, blockers
      .map((blocker) => {
        if (!Number.isSafeInteger(blocker.number) || !Number.isSafeInteger(blocker.id)) throw new Error(`Malformed blocker for Issue #${issue.number}`);
        return byNumber.get(blocker.number)?.id === blocker.id ? blocker.number : `foreign:${blocker.id}`;
      }));
  }
  const labels = ghJson(`repos/${github}/labels?per_page=100`, { pages: true });
  for (const label of labels) {
    if (typeof label.name !== "string" || typeof label.color !== "string") throw new Error("Malformed GitHub label response");
  }
  return { issues, byTicket, deps, labels, byNumber };
}

export function planLabels(remoteLabels) {
  const current = new Map(remoteLabels.map((label) => [label.name.toLowerCase(), label]));
  return ALL_LABELS.flatMap((label) => {
    const existing = current.get(label.name.toLowerCase());
    if (!existing) return [{ kind: "label-create", ...label }];
    if (existing.color.toLowerCase() !== label.color || (existing.description ?? "") !== label.description) {
      return [{ kind: "label-update", ...label, name: existing.name }];
    }
    return [];
  });
}

function planRemote(projection, remote) {
  const { byTicket, creates } = planSync(projection, remote.issues);
  for (const item of creates) {
    byTicket.set(item.ticket_id, { number: null, title: item.title, body: "", state: "open", labels: item.labels, comments: [] });
  }
  const unresolvedDeps = projection.flatMap((item) => item.depends_on
    .filter((id) => !byTicket.get(item.ticket_id).number || !byTicket.get(id).number)
    .map((id) => ({ kind: "dep-add", ticket_id: item.ticket_id, number: byTicket.get(item.ticket_id).number, blocker_ticket_id: id })));
  return [
    ...planLabels(remote.labels),
    ...creates.map((item) => ({ kind: "create", ticket_id: item.ticket_id, title: item.title, labels: item.labels })),
    ...planUpdates(projection, byTicket),
    ...planDependencies(projection, byTicket, remote.deps),
    ...unresolvedDeps,
  ];
}

function operationIdentity(op) {
  return { kind: op.kind, ...(op.ticket_id && { ticket_id: op.ticket_id }), ...(op.number && { number: op.number }),
    ...(op.evidence_id && { evidence_id: op.evidence_id }), ...(op.blocker && { blocker: op.blocker }),
    ...(op.blocker_ticket_id && { blocker_ticket_id: op.blocker_ticket_id }),
    ...(op.name && { label: op.name }) };
}

function remoteDiagnostics(projection, remote) {
  const desired = new Map(projection.map((item) => [item.ticket_id, item]));
  const orphans = [];
  const changedEvidence = [];
  for (const [id, issue] of remote.byTicket) {
    const item = desired.get(id);
    if (!item) { orphans.push({ ticket_id: id, number: issue.number }); continue; }
    const comments = new Map(issue.comments.map((comment) => [markerValue(comment.body, EVIDENCE_MARKER), comment.body]));
    for (const comment of item.comments) {
      if (comments.has(comment.evidence_id) && normalize(comments.get(comment.evidence_id)) !== normalize(comment.body)) {
        changedEvidence.push({ ticket_id: id, number: issue.number, evidence_id: comment.evidence_id });
      }
    }
  }
  return { orphans, changed_evidence: changedEvidence };
}

async function applyOperation(github, op, remote, recordWrite, writeDelayMs) {
  const base = `repos/${github}`;
  const write = async (endpoint, method, body) => {
    command("gh", ["api", endpoint, "--method", method, ...(body === undefined ? [] : ["--input", "-"])],
      { input: body === undefined ? undefined : JSON.stringify(body) });
    recordWrite();
    if (writeDelayMs > 0) await new Promise((done) => setTimeout(done, writeDelayMs));
  };
  if (op.kind === "label-create" || op.kind === "label-update") {
    const endpoint = op.kind === "label-create" ? `${base}/labels` : `${base}/labels/${encodeURIComponent(op.name)}`;
    await write(endpoint, op.kind === "label-create" ? "POST" : "PATCH", {
      ...(op.kind === "label-create" && { name: op.name }), color: op.color, description: op.description,
    });
  } else if (op.kind === "create") {
    await write(`${base}/issues`, "POST", { title: op.title, body: `<!-- ${TICKET_MARKER}=${op.ticket_id} -->\nProvisioning…`, labels: op.labels });
  } else if (op.kind === "comment") {
    await write(`${base}/issues/${op.number}/comments`, "POST", { body: op.body });
  } else if (op.kind === "update") {
    await write(`${base}/issues/${op.number}`, "PATCH", { title: op.title, body: op.body });
    if (op.addLabels.length) await write(`${base}/issues/${op.number}/labels`, "POST", { labels: op.addLabels });
    for (const name of op.removeLabels) await write(`${base}/issues/${op.number}/labels/${encodeURIComponent(name)}`, "DELETE");
  } else if (op.kind === "close" || op.kind === "reopen") {
    await write(`${base}/issues/${op.number}`, "PATCH", { state: op.kind === "close" ? "closed" : "open" });
  } else {
    const blockerId = remote.byNumber.get(op.blocker).id;
    const endpoint = `${base}/issues/${op.number}/dependencies/blocked_by`;
    if (op.kind === "dep-add") await write(endpoint, "POST", { issue_id: blockerId });
    else await write(`${endpoint}/${blockerId}`, "DELETE");
  }
}

function optionsForSync(options) {
  const modes = [options.check && "check", options.dryRun && "dry-run", options.publish && "publish", options.mode].filter(Boolean);
  if (modes.length === 0) throw new Error("GitHub publishing is disabled by default. Explicitly choose --check, --dry-run or --publish.");
  if (modes.length !== 1 || !["check", "dry-run", "publish"].includes(modes[0])) throw new Error("Choose either --check, --dry-run or --publish.");
  const mode = modes[0];
  if (mode !== "check" && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.github ?? "")) {
    throw new Error("--github owner/repo is required; the destination is never inferred");
  }
  if (mode === "publish" && !options.ref) throw new Error("Publishing requires an explicit --ref for committed canonical-branch records");
  return { ...options, mode, ref: options.ref ?? "HEAD" };
}

function errorMessage(error, snapshot) {
  const details = error.details?.errors ?? [];
  return [error.message, ...details.map((item) => `${item.path}: ${item.message}`)].join("\n")
    .replaceAll(`${snapshot}/`, "");
}

export async function sync(options) {
  const { repoRoot, github, mode, ref, report: reportPath, log = console.log, writeDelayMs = 1000 } = optionsForSync(options);
  const report = { mode, status: "failed", source: null, code_sha: null, tickets: 0, issues: 0,
    planned: [], completed: [], remaining: [], writes: 0, converged: false, orphans: [], changed_evidence: [] };
  let snapshot;
  let activeOperation;
  try {
    const sha = command("git", ["-C", repoRoot, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
    report.source = { sha, branch: null };
    const code = spawnSync("git", ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "HEAD"], { encoding: "utf8" });
    report.code_sha = code.status === 0 ? code.stdout.trim() : null;
    snapshot = mkdtempSync(join(tmpdir(), "vibehub-issues-"));
    const sourceRoot = join(snapshot, "source");
    command("git", ["clone", "--shared", "--no-checkout", "--quiet", "--", resolve(repoRoot), sourceRoot]);
    command("git", ["-C", sourceRoot, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", "--quiet", sha]);
    log(`Source ${sha}; implementation ${report.code_sha ?? "unversioned"}; mode ${mode}`);
    if (!existsSync(join(sourceRoot, ".vibehub"))) {
      report.status = "no-shared-project";
      log("No shared VibeHub project at this commit; no GitHub reads or writes.");
      return report;
    }
    const helper = fileURLToPath(new URL("../skills/vibehub-core/scripts/vh.mjs", import.meta.url));
    const compatibilityResult = spawnSync(process.execPath, [helper, "project", "compatibility", "--repo", sourceRoot], { encoding: "utf8" });
    if (!compatibilityResult.stdout) throw new Error(compatibilityResult.error?.message || compatibilityResult.stderr || "Project compatibility check failed");
    const compatibility = JSON.parse(compatibilityResult.stdout);
    if (!compatibility.ok) throw Object.assign(new Error(compatibility.error.message), { details: compatibility.error.details });
    if (compatibility.data.state !== "CURRENT") throw new Error(`.vibehub/version.yaml: ${compatibility.data.state}. ${compatibility.data.reason}`);
    let projection = computeProjection(sourceRoot, github);
    report.tickets = projection.length;
    if (mode === "check") {
      report.status = "validated";
      log(`Validated ${projection.length} committed Tickets offline.`);
      return report;
    }
    const head = canonicalHead(github);
    report.source.branch = head.branch;
    if (mode === "publish" && head.sha !== sha) throw new Error(`Source ${sha} is not the current ${head.branch} commit ${head.sha}; fetch and reconcile the canonical branch`);
    if (head.branch !== "main") projection = computeProjection(sourceRoot, github, head.branch);
    let remote = readRemote(github);
    report.issues = remote.issues.length;
    Object.assign(report, remoteDiagnostics(projection, remote));
    let plan = planRemote(projection, remote);
    report.planned = plan.map(operationIdentity);
    report.remaining = [...report.planned];
    log(`${projection.length} committed Tickets, ${remote.issues.length} Issues, ${report.orphans.length} orphan mirrors, ${plan.length} planned operations`);
    if (mode === "dry-run") {
      for (const op of report.planned) log(JSON.stringify(op));
      report.status = "planned";
      log(`Dry run: ${plan.filter((op) => op.kind === "create").length} creates; follow-up bodies and dependencies are resolved after new Issue numbers exist. No writes.`);
      return report;
    }
    const current = canonicalHead(github);
    if (current.sha !== sha || current.branch !== head.branch) {
      report.status = "superseded";
      log("Canonical branch changed before writes; reconcile its latest commit.");
      return report;
    }
    if (plan.length === 0) {
      report.status = "converged";
      report.converged = true;
      log(`converged: 0 writes; 0 remaining operations; source ${sha}`);
      return report;
    }
    const apply = async (operations, pending = operations) => {
      report.remaining = pending.map(operationIdentity);
      for (const op of operations) {
        activeOperation = operationIdentity(op);
        log(JSON.stringify(activeOperation));
        await applyOperation(github, op, remote, () => { report.writes += 1; }, writeDelayMs);
        report.completed.push(activeOperation);
        report.remaining.shift();
        activeOperation = null;
      }
    };
    const provisioning = plan.filter((op) => ["label-create", "label-update", "create"].includes(op.kind));
    await apply(provisioning, plan);
    if (provisioning.length) remote = readRemote(github);
    plan = planRemote(projection, remote);
    report.planned = [...provisioning, ...plan].map(operationIdentity);
    if (plan.some((op) => ["label-create", "label-update", "create"].includes(op.kind))) {
      report.remaining = plan.map(operationIdentity);
      throw new Error("Provisioning did not converge; no create is retried automatically. Reconcile after inspecting the remote state.");
    }
    await apply(plan);
    const finalRemote = readRemote(github);
    report.issues = finalRemote.issues.length;
    report.remaining = planRemote(projection, finalRemote).map(operationIdentity);
    Object.assign(report, remoteDiagnostics(projection, finalRemote));
    if (report.remaining.length) throw new Error(`Post-write verification failed: ${report.remaining.length} managed operations remain`);
    const finalHead = canonicalHead(github);
    report.status = finalHead.sha === sha && finalHead.branch === head.branch ? "converged" : "superseded";
    report.converged = report.status === "converged";
    log(`${report.status}: ${report.writes} writes; ${report.remaining.length} remaining operations; source ${sha}`);
    return report;
  } catch (error) {
    report.error = errorMessage(error, snapshot && join(snapshot, "source"));
    if (activeOperation) report.failed_operation = activeOperation;
    throw Object.assign(new Error(report.error), { report });
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
}

export function parseArgs(argv) {
  const args = { repo: process.cwd(), github: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (["--repo", "--github", "--ref", "--report"].includes(a)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${a} requires a value`);
      args[a.slice(2)] = a === "--repo" || a === "--report" ? resolve(value) : value;
    } else if (a === "--check") args.check = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--publish") args.publish = true;
    else throw new Error(`unknown argument ${a}`);
  }
  optionsForSync(args);
  return args;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await sync({ ...args, repoRoot: args.repo });
  } catch (error) {
    console.error(error.message);
    if (error.report?.failed_operation) console.error(`Stopped after uncertain write: ${JSON.stringify(error.report.failed_operation)}. Reconcile again after checking its remote marker; no write was retried.`);
    process.exitCode = 1;
  }
}
