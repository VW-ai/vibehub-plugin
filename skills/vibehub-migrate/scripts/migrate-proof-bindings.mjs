#!/usr/bin/env node
// Deterministic format 2 -> 3 proof-binding migration: reconstruct the
// acceptance contract each legacy Evidence and Outcome document was checked
// in beside — from its first Git addition on the current HEAD ancestry only —
// and record it as a reconstructed binding, or an unresolved marker where
// history is missing, ambiguous, or the contract drifted afterwards. The dry
// run emits an impact report whose every count is recomputed at the migration
// HEAD; the apply preserves every historical document byte-for-byte except
// the registered schema_version bump and the one inserted optional field, and
// a second apply at the same HEAD is byte-identical.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  contractIdentity,
  documents,
  loadRepository,
  outcomeAccepted,
  projectTicketQuery,
  ticketArchived,
  ticketNextAction,
  ticketStatus,
} from "../../vibehub-core/scripts/vh.mjs";

const FROM_FORMAT = 2;
const TO_FORMAT = 3;
const TARGET_DOCUMENT_SCHEMA = 2;

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  }
  return result;
}

// The proven reconstruction semantics of scripts/audit-legacy-proof.mjs: the
// document's first addition on the current HEAD ancestry — never another
// branch, never --all. A re-added file reconstructs from its current
// incarnation's addition.
export function firstCurrentAddition(repo, path) {
  const output = git(repo, ["log", "--follow", "--diff-filter=A", "--format=%H", "HEAD", "--", path], {
    allowFailure: true,
  }).stdout.trim();
  return output ? output.split("\n")[0] : null;
}

function documentAt(repo, commit, path) {
  if (!commit) return null;
  const result = git(repo, ["show", `${commit}:${path}`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Byte-preserving upgrade of one persisted document: the parsed key order is
// the file's own order, so re-serializing changes nothing except the
// schema_version value and the one inserted optional field. A file that is
// not exactly JSON.stringify(parsed, null, 2) is refused rather than
// silently normalized.
function upgradedSource(source, path, key, value) {
  const document = JSON.parse(source);
  if (`${JSON.stringify(document, null, 2)}\n` !== source) {
    throw new Error(`refusing to rewrite a non-canonically-serialized document: ${path}`);
  }
  document.schema_version = TARGET_DOCUMENT_SCHEMA;
  if (value === undefined || key in document) {
    if (value !== undefined) document[key] = value;
    return `${JSON.stringify(document, null, 2)}\n`;
  }
  const entries = Object.entries(document);
  const at = entries.findIndex(([existing]) => existing > key);
  entries.splice(at < 0 ? entries.length : at, 0, [key, value]);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

function writeBytes(path, bytes) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
}

function historicalContract(repo, entry) {
  const path = relative(repo, entry.path);
  const addedCommit = firstCurrentAddition(repo, path);
  const ticketPath = `.vibehub/tickets/${entry.document.ticket_id}.yaml`;
  const historicalTicket = documentAt(repo, addedCommit, ticketPath);
  return {
    path,
    added_commit: addedCommit,
    identity: historicalTicket ? contractIdentity(historicalTicket) : null,
  };
}

function driftedIds(historicalIdentity, currentIdentity) {
  return [...new Set([
    ...Object.keys(historicalIdentity.criterion_digests),
    ...Object.keys(currentIdentity.criterion_digests),
  ])].sort().filter((id) =>
    historicalIdentity.criterion_digests[id] !== currentIdentity.criterion_digests[id]);
}

function planEvidence(repo, repository, entry) {
  const document = entry.document;
  const currentTicket = repository.tickets.documents.get(document.ticket_id).document;
  const currentIdentity = contractIdentity(currentTicket);
  if ((document.acceptance_bindings ?? []).some((binding) => binding.binding === "native")) {
    return { skipped_native: true, evidence_id: document.evidence_id, ticket_id: document.ticket_id };
  }
  const { path, added_commit: addedCommit, identity } = historicalContract(repo, entry);
  const unresolvedReasons = [];
  if (!addedCommit) unresolvedReasons.push("no-addition-commit");
  else if (!identity) unresolvedReasons.push("ticket-unreadable-at-addition");
  const bindings = identity
    ? document.acceptance_ids
      .filter((id) => identity.criterion_digests[id] !== undefined)
      .map((id) => ({
        acceptance_id: id,
        digest: identity.criterion_digests[id],
        binding: "reconstructed",
        provenance_ref: `commit:${addedCommit}`,
      }))
    : [];
  const missingIds = identity
    ? document.acceptance_ids.filter((id) => identity.criterion_digests[id] === undefined)
    : [];
  if (missingIds.length > 0) unresolvedReasons.push("referenced-acceptance-missing-at-addition");
  const staleIds = bindings
    .filter((binding) => binding.digest !== currentIdentity.criterion_digests[binding.acceptance_id])
    .map((binding) => binding.acceptance_id);
  return {
    kind: "evidence",
    evidence_id: document.evidence_id,
    ticket_id: document.ticket_id,
    path,
    added_commit: addedCommit,
    unresolved_reasons: unresolvedReasons,
    bound_acceptance_ids: bindings.map((binding) => binding.acceptance_id),
    missing_at_addition_ids: missingIds,
    stale_acceptance_ids: staleIds,
    document: JSON.parse(upgradedSource(
      readFileSync(entry.path, "utf8"),
      path,
      "acceptance_bindings",
      bindings.length > 0 ? bindings : undefined,
    )),
  };
}

function planOutcome(repo, repository, entry) {
  const document = entry.document;
  const currentTicket = repository.tickets.documents.get(document.ticket_id).document;
  const currentIdentity = contractIdentity(currentTicket);
  if (document.contract_binding?.binding === "native") {
    return { skipped_native: true, ticket_id: document.ticket_id };
  }
  const { path, added_commit: addedCommit, identity } = historicalContract(repo, entry);
  const referencedIds = [...document.accepted_acceptance_ids, ...document.unresolved_acceptance_ids];
  let binding;
  if (!addedCommit) {
    binding = { binding: "reconstructed", unresolved: { reason: "no-addition-commit" } };
  } else if (!identity) {
    binding = { binding: "reconstructed", unresolved: { reason: "ticket-unreadable-at-addition" } };
  } else {
    const missingIds = referencedIds.filter((id) => identity.criterion_digests[id] === undefined);
    if (missingIds.length > 0) {
      binding = {
        binding: "reconstructed",
        unresolved: { reason: "referenced-acceptance-missing-at-addition", acceptance_ids: missingIds.sort() },
      };
    } else if (identity.contract_digest === currentIdentity.contract_digest) {
      binding = { digest: identity.contract_digest, binding: "reconstructed" };
    } else {
      binding = {
        digest: identity.contract_digest,
        binding: "reconstructed",
        unresolved: {
          reason: "contract-drifted-since-addition",
          acceptance_ids: driftedIds(identity, currentIdentity),
        },
      };
    }
  }
  return {
    kind: "outcome",
    ticket_id: document.ticket_id,
    status: document.status,
    path,
    added_commit: addedCommit,
    unresolved_reason: binding.unresolved?.reason ?? null,
    unresolved_acceptance_ids: binding.unresolved?.acceptance_ids ?? [],
    document: JSON.parse(upgradedSource(readFileSync(entry.path, "utf8"), path, "contract_binding", binding)),
  };
}

function simulatedRepository(repository, evidenceEntries, outcomeEntries, formatVersion) {
  return {
    ...repository,
    format_version: formatVersion,
    evidence: {
      ...repository.evidence,
      documents: new Map(evidenceEntries.map((entry) => [entry.document.evidence_id, entry])),
    },
    outcomes: {
      ...repository.outcomes,
      documents: new Map(outcomeEntries.map((entry) => [entry.document.ticket_id, entry])),
    },
  };
}

// The retention matrix, recomputed through the one canonical projection —
// ticketStatus, ticketNextAction (with its proof explanation), ticketArchived
// and projectTicketQuery — never through a parallel derivation.
function retention(repository) {
  const tickets = documents(repository.tickets.documents);
  const actions = new Map(tickets.map((ticket) => [ticket.ticket_id, ticketNextAction(repository, ticket)]));
  const humanCriteria = tickets.flatMap((ticket) => ticket.acceptance
    .filter((criterion) => (criterion.authority ?? "agent") === "human")
    .map((criterion) => ({ ticket_id: ticket.ticket_id, acceptance_id: criterion.acceptance_id })));
  const doneIds = new Set(tickets
    .filter((ticket) => ticketStatus(repository, ticket) === "DONE")
    .map((ticket) => ticket.ticket_id));
  return {
    done_tickets: doneIds.size,
    archived_tickets: tickets.filter((ticket) => ticketArchived(repository, ticket)).length,
    close_out_tickets: tickets.filter((ticket) => actions.get(ticket.ticket_id).action === "CLOSE_OUT").length,
    replan_unresolved_tickets: tickets
      .filter((ticket) => actions.get(ticket.ticket_id).reason === "unresolved_legacy_outcome")
      .map((ticket) => ticket.ticket_id)
      .sort(),
    stale_coverage_tickets: tickets
      .filter((ticket) => actions.get(ticket.ticket_id).proof.stale_acceptance_ids.length > 0)
      .map((ticket) => ticket.ticket_id)
      .sort(),
    human_authority_criteria: humanCriteria.length,
    human_authority_criteria_satisfied: humanCriteria.filter(({ ticket_id: ticketId, acceptance_id: acceptanceId }) => {
      const entry = actions.get(ticketId).proof.acceptance
        .find((item) => item.acceptance_id === acceptanceId);
      return Boolean(entry?.human_covered);
    }).length,
    current_graph_tickets: projectTicketQuery(repository, { scope: "current" }).tickets.length,
    all_graph_tickets: projectTicketQuery(repository, { scope: "all" }).tickets.length,
    successful_prerequisite_edges: tickets.flatMap((ticket) => ticket.relations)
      .filter((relation) => Boolean(outcomeAccepted(repository, relation.target_ticket_id))).length,
    open_dependents_unblocked: tickets.filter((ticket) => {
      if (outcomeAccepted(repository, ticket.ticket_id) || ticket.relations.length === 0) return false;
      return ticket.relations.every((relation) => Boolean(outcomeAccepted(repository, relation.target_ticket_id)));
    }).length,
  };
}

function changedProjection(before, after, tickets) {
  return tickets
    .map((ticket) => {
      const beforeAction = before.get(ticket.ticket_id);
      const afterAction = after.get(ticket.ticket_id);
      if (beforeAction.action === afterAction.action && beforeAction.reason === afterAction.reason) return null;
      return {
        ticket_id: ticket.ticket_id,
        before: { action: beforeAction.action, reason: beforeAction.reason },
        after: { action: afterAction.action, reason: afterAction.reason },
        acceptance_ids: afterAction.acceptance_ids,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
}

export function migrateProofBindings(repo, { apply = false } = {}) {
  const root = resolve(repo);
  const repository = loadRepository(root);
  assertValid(repository.errors);
  const fromFormat = repository.format_version;
  if (fromFormat !== FROM_FORMAT && fromFormat !== TO_FORMAT) {
    throw new Error(`proof-binding migration expects project format ${FROM_FORMAT} (or ${TO_FORMAT} for a replay); found ${String(fromFormat)}`);
  }
  const head = git(root, ["rev-parse", "HEAD"], { allowFailure: true }).stdout.trim() || null;
  const evidenceEntries = [...repository.evidence.documents.values()];
  const outcomeEntries = [...repository.outcomes.documents.values()];
  const evidencePlans = evidenceEntries.map((entry) => ({ entry, plan: planEvidence(root, repository, entry) }));
  const outcomePlans = outcomeEntries.map((entry) => ({ entry, plan: planOutcome(root, repository, entry) }));

  const migratedEvidence = evidencePlans.map(({ entry, plan }) =>
    (plan.skipped_native ? entry : { ...entry, document: plan.document }));
  const migratedOutcomes = outcomePlans.map(({ entry, plan }) =>
    (plan.skipped_native ? entry : { ...entry, document: plan.document }));

  const before = simulatedRepository(repository, evidenceEntries, outcomeEntries, FROM_FORMAT);
  const after = simulatedRepository(repository, migratedEvidence, migratedOutcomes, TO_FORMAT);
  const tickets = documents(repository.tickets.documents);
  const beforeActions = new Map(tickets.map((ticket) => [ticket.ticket_id, ticketNextAction(before, ticket)]));
  const afterActions = new Map(tickets.map((ticket) => [ticket.ticket_id, ticketNextAction(after, ticket)]));

  const evidenceAudits = evidencePlans.filter(({ plan }) => !plan.skipped_native).map(({ plan }) => plan);
  const outcomeAudits = outcomePlans.filter(({ plan }) => !plan.skipped_native).map(({ plan }) => plan);
  const report = {
    schema_version: 1,
    kind: "vibehub_proof_binding_migration_report",
    mode: apply ? "apply" : "dry-run",
    from_format: FROM_FORMAT,
    to_format: TO_FORMAT,
    audited_commit: head,
    corpus: {
      tickets: tickets.length,
      evidence: evidenceEntries.length,
      outcomes: outcomeEntries.length,
      successful_outcomes: outcomeEntries.filter((entry) => entry.document.status === "successful").length,
    },
    evidence: {
      total: evidenceEntries.length,
      skipped_native: evidencePlans.filter(({ plan }) => plan.skipped_native).length,
      reconstructed: evidenceAudits.filter((plan) => plan.bound_acceptance_ids.length > 0).length,
      unresolved: evidenceAudits
        .filter((plan) => plan.unresolved_reasons.length > 0)
        .map((plan) => ({
          evidence_id: plan.evidence_id,
          ticket_id: plan.ticket_id,
          reasons: plan.unresolved_reasons,
          missing_at_addition_ids: plan.missing_at_addition_ids,
        }))
        .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
      drifted: evidenceAudits
        .filter((plan) => plan.stale_acceptance_ids.length > 0)
        .map((plan) => ({
          evidence_id: plan.evidence_id,
          ticket_id: plan.ticket_id,
          stale_acceptance_ids: plan.stale_acceptance_ids,
        }))
        .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id)),
    },
    outcomes: {
      total: outcomeEntries.length,
      skipped_native: outcomePlans.filter(({ plan }) => plan.skipped_native).length,
      reconstructed_current: outcomeAudits.filter((plan) => plan.unresolved_reason === null).length,
      unresolved: outcomeAudits
        .filter((plan) => plan.unresolved_reason !== null)
        .map((plan) => ({
          ticket_id: plan.ticket_id,
          status: plan.status,
          reason: plan.unresolved_reason,
          acceptance_ids: plan.unresolved_acceptance_ids,
        }))
        .sort((left, right) => left.ticket_id.localeCompare(right.ticket_id)),
    },
    retention: {
      before: retention(before),
      after: retention(after),
    },
    changed_projection: changedProjection(beforeActions, afterActions, tickets),
  };

  if (!apply) return report;

  let rewritten = 0;
  let unchanged = 0;
  for (const { entry, plan } of [...evidencePlans, ...outcomePlans]) {
    if (plan.skipped_native) {
      unchanged += 1;
      continue;
    }
    const bytes = `${JSON.stringify(plan.document, null, 2)}\n`;
    if (readFileSync(entry.path, "utf8") === bytes) unchanged += 1;
    else {
      writeBytes(entry.path, bytes);
      rewritten += 1;
    }
  }
  const versionPath = join(root, ".vibehub", "version.yaml");
  const versionSource = readFileSync(versionPath, "utf8");
  const versionDocument = JSON.parse(versionSource);
  if (`${JSON.stringify(versionDocument, null, 2)}\n` !== versionSource) {
    throw new Error(`refusing to rewrite a non-canonically-serialized document: ${versionPath}`);
  }
  versionDocument.format_version = TO_FORMAT;
  const versionBytes = `${JSON.stringify(versionDocument, null, 2)}\n`;
  if (versionSource !== versionBytes) writeBytes(versionPath, versionBytes);

  // The migrated repository must project exactly what the report predicted;
  // anything else refuses loudly rather than landing a silently-wrong tree.
  const migrated = loadRepository(root);
  assertValid(migrated.errors);
  if (migrated.format_version !== TO_FORMAT) throw new Error("apply did not reach the target format");
  const actual = retention(migrated);
  if (JSON.stringify(actual) !== JSON.stringify(report.retention.after)) {
    throw new Error(`retention after apply does not equal the report: ${JSON.stringify({ report: report.retention.after, actual })}`);
  }
  return {
    ...report,
    apply: {
      rewritten_documents: rewritten,
      unchanged_documents: unchanged,
      format_marker: versionPath,
      retention_verified_after_apply: true,
    },
  };
}

function parseArgs(argv) {
  let repo = process.cwd();
  let apply = false;
  let reportPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") repo = argv[++index] ?? "";
    else if (value === "--apply") apply = true;
    else if (value === "--report") reportPath = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!repo) throw new Error("--repo needs a path");
  return { repo: resolve(repo), apply, reportPath };
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const { repo, apply, reportPath } = parseArgs(process.argv.slice(2));
    if (!existsSync(repo)) throw new Error(`Repository path does not exist: ${repo}`);
    const report = migrateProofBindings(repo, { apply });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (reportPath) writeFileSync(reportPath, serialized);
    process.stdout.write(serialized);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
