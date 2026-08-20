#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertValid,
  documents,
  loadRepository,
  ticketArchived,
} from "../skills/scripts/vh.mjs";

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

function parseArgs(argv) {
  let repo = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repo") repo = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!repo) throw new Error("--repo needs a path");
  return { repo: resolve(repo) };
}

function contract(acceptance) {
  return {
    acceptance_id: acceptance.acceptance_id,
    authority: acceptance.authority ?? "agent",
    criterion: acceptance.criterion,
  };
}

function contractSet(ticket) {
  return ticket.acceptance
    .map(contract)
    .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function firstCurrentAddition(repo, path) {
  const output = git(repo, ["log", "--all", "--diff-filter=A", "--format=%H", "--", path], {
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

function reconstruct(repository, repo, entry, kind) {
  const document = entry.document;
  const path = relative(repo, entry.path);
  const addedCommit = firstCurrentAddition(repo, path);
  const ticketPath = `.vibehub/tickets/${document.ticket_id}.yaml`;
  const historicalTicket = documentAt(repo, addedCommit, ticketPath);
  const currentTicket = repository.tickets.documents.get(document.ticket_id)?.document ?? null;
  const referencedIds = kind === "evidence"
    ? document.acceptance_ids
    : [...document.accepted_acceptance_ids, ...document.unresolved_acceptance_ids];
  const historicalById = new Map((historicalTicket?.acceptance ?? [])
    .map((item) => [item.acceptance_id, contract(item)]));
  const currentById = new Map((currentTicket?.acceptance ?? [])
    .map((item) => [item.acceptance_id, contract(item)]));
  const missingHistoricalIds = referencedIds.filter((id) => !historicalById.has(id));
  const changedCurrentIds = referencedIds.filter((id) => {
    const historical = historicalById.get(id);
    const current = currentById.get(id);
    return historical && (!current || !same(historical, current));
  });
  const membershipDrift = Boolean(
    historicalTicket && currentTicket && !same(contractSet(historicalTicket), contractSet(currentTicket)),
  );
  const unresolvedReasons = [];
  if (!addedCommit) unresolvedReasons.push("no-addition-commit");
  if (addedCommit && !historicalTicket) unresolvedReasons.push("ticket-unreadable-at-addition");
  if (missingHistoricalIds.length > 0) unresolvedReasons.push("referenced-acceptance-missing-at-addition");
  return {
    kind,
    id: kind === "evidence" ? document.evidence_id : document.ticket_id,
    ticket_id: document.ticket_id,
    path,
    added_commit: addedCommit,
    reconstructable_from_first_git_appearance: unresolvedReasons.length === 0,
    unresolved_reasons: unresolvedReasons,
    missing_historical_acceptance_ids: missingHistoricalIds,
    changed_current_acceptance_ids: changedCurrentIds,
    ticket_contract_drifted_since_addition: membershipDrift,
  };
}

function countWhere(items, predicate) {
  return items.filter(predicate).length;
}

function dependencyImpact(tickets, acceptedOutcomeIds) {
  const successfulPrerequisiteEdges = tickets.flatMap((ticket) => ticket.relations)
    .filter((relation) => acceptedOutcomeIds.has(relation.target_ticket_id)).length;
  const openDependentsUnblocked = tickets.filter((ticket) => {
    if (acceptedOutcomeIds.has(ticket.ticket_id) || ticket.relations.length === 0) return false;
    return ticket.relations.every((relation) => acceptedOutcomeIds.has(relation.target_ticket_id));
  }).length;
  return { successful_prerequisite_edges: successfulPrerequisiteEdges, open_dependents_unblocked: openDependentsUnblocked };
}

export function auditLegacyProof(repo) {
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  const tickets = documents(repository.tickets.documents);
  const evidence = [...repository.evidence.documents.values()];
  const outcomes = [...repository.outcomes.documents.values()];
  const evidenceAudit = evidence.map((entry) => reconstruct(repository, repo, entry, "evidence"));
  const outcomeAudit = outcomes.map((entry) => reconstruct(repository, repo, entry, "outcome"));
  const successfulOutcomes = outcomes.filter((entry) => entry.document.status === "successful");
  const currentSuccessfulIds = new Set(successfulOutcomes.map((entry) => entry.document.ticket_id));
  const reconstructableSuccessfulIds = new Set(successfulOutcomes
    .filter((entry) => {
      const audit = outcomeAudit.find((item) => item.ticket_id === entry.document.ticket_id);
      return audit?.reconstructable_from_first_git_appearance
        && !audit.ticket_contract_drifted_since_addition;
    })
    .map((entry) => entry.document.ticket_id));
  const humanCriteria = tickets.flatMap((ticket) => ticket.acceptance
    .filter((item) => (item.authority ?? "agent") === "human")
    .map((item) => ({ ticket_id: ticket.ticket_id, acceptance_id: item.acceptance_id })));
  const currentHumanSatisfied = humanCriteria.filter(({ ticket_id, acceptance_id }) => {
    const outcome = repository.outcomes.documents.get(ticket_id)?.document;
    if (outcome?.status !== "successful" || !outcome.accepted_acceptance_ids.includes(acceptance_id)) return false;
    return outcome.evidence_ids.some((evidenceId) => {
      const item = repository.evidence.documents.get(evidenceId)?.document;
      return item?.acceptance_ids.includes(acceptance_id) && (item.origin ?? "agent") === "human";
    });
  });
  const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  return {
    schema_version: 1,
    audited_commit: head,
    corpus: {
      tickets: tickets.length,
      evidence: evidence.length,
      outcomes: outcomes.length,
      successful_outcomes: successfulOutcomes.length,
      archived_tickets: tickets.filter((ticket) => ticketArchived(repository, ticket)).length,
      human_authority_criteria: humanCriteria.length,
      human_authority_criteria_currently_satisfied: currentHumanSatisfied.length,
      human_origin_evidence: evidence.filter((entry) => (entry.document.origin ?? "agent") === "human").length,
    },
    reconstruction: {
      evidence: {
        reconstructable_from_first_git_appearance: countWhere(evidenceAudit, (item) => item.reconstructable_from_first_git_appearance),
        unresolved: countWhere(evidenceAudit, (item) => !item.reconstructable_from_first_git_appearance),
        contract_drifted_since_addition: countWhere(evidenceAudit, (item) => item.ticket_contract_drifted_since_addition),
      },
      outcomes: {
        reconstructable_from_first_git_appearance: countWhere(outcomeAudit, (item) => item.reconstructable_from_first_git_appearance),
        unresolved: countWhere(outcomeAudit, (item) => !item.reconstructable_from_first_git_appearance),
        contract_drifted_since_addition: countWhere(outcomeAudit, (item) => item.ticket_contract_drifted_since_addition),
      },
      unresolved_examples: [...evidenceAudit, ...outcomeAudit]
        .filter((item) => !item.reconstructable_from_first_git_appearance)
        .slice(0, 12),
      evidence_drift_examples: evidenceAudit
        .filter((item) => item.ticket_contract_drifted_since_addition)
        .slice(0, 12),
      outcome_drift_examples: outcomeAudit
        .filter((item) => item.ticket_contract_drifted_since_addition)
        .slice(0, 12),
      limitation: "Git proves the contract at a document's first appearance in this repository, not the unrecorded creation-time intent before that commit.",
    },
    policy_impact: {
      mark_all_legacy_stale: {
        done_tickets_retained: 0,
        archived_tickets_retained: 0,
        human_authority_satisfactions_retained: 0,
        ...dependencyImpact(tickets, new Set()),
      },
      grandfather_current_successful_outcomes: {
        done_tickets_retained: currentSuccessfulIds.size,
        archived_tickets_retained: tickets.filter((ticket) =>
          currentSuccessfulIds.has(ticket.ticket_id) && ticketArchived(repository, ticket)).length,
        human_authority_satisfactions_retained: currentHumanSatisfied.length,
        ...dependencyImpact(tickets, currentSuccessfulIds),
      },
      reconstruct_from_git_without_drift: {
        done_tickets_retained: reconstructableSuccessfulIds.size,
        archived_tickets_retained: tickets.filter((ticket) =>
          reconstructableSuccessfulIds.has(ticket.ticket_id) && ticketArchived(repository, ticket)).length,
        human_authority_satisfactions_retained: currentHumanSatisfied
          .filter((item) => reconstructableSuccessfulIds.has(item.ticket_id)).length,
        ...dependencyImpact(tickets, reconstructableSuccessfulIds),
      },
    },
  };
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const { repo } = parseArgs(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(auditLegacyProof(repo), null, 2)}\n`);
}
