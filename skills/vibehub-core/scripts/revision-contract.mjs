import { createHash } from "node:crypto";

export const REVISION_IDENTITY = /^sha256:[0-9a-f]{64}$/u;
export const REVISION_BINDING_STATES = new Set([
  "bound",
  "legacy-pending-reconstruction",
  "legacy-unresolved",
]);
export const REVISION_BINDING_ORIGINS = new Set(["native", "reconstructed"]);

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function semanticDigest(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex")}`;
}

export function acceptanceRevisionKey(reference) {
  return `${reference.acceptance_id}@${reference.revision}`;
}

export function acceptanceIdentity(ticketId, acceptance) {
  return semanticDigest({
    ticket_id: ticketId,
    acceptance_id: acceptance.acceptance_id,
    revision: acceptance.revision,
    criterion: acceptance.criterion,
    authority: acceptance.authority ?? "agent",
    derived_from: [...(acceptance.derived_from ?? [])]
      .map(({ acceptance_id, revision }) => ({ acceptance_id, revision }))
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
        || left.revision - right.revision),
  });
}

export function acceptanceReference(acceptance) {
  return {
    acceptance_id: acceptance.acceptance_id,
    revision: acceptance.revision,
    identity: acceptance.identity,
  };
}

export function contractIdentity(ticketId, contract) {
  return semanticDigest({
    ticket_id: ticketId,
    revision: contract.revision,
    acceptance_revisions: [...contract.acceptance_revisions]
      .map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity }))
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
        || left.revision - right.revision),
  });
}

export function buildContractRevision(ticketId, revision, acceptance) {
  const contract = {
    revision,
    acceptance_revisions: acceptance
      .filter((item) => item.state === "active")
      .map(acceptanceReference)
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
        || left.revision - right.revision),
  };
  return { ...contract, identity: contractIdentity(ticketId, contract) };
}

export function materializeInitialTicket(ticket) {
  const acceptance = ticket.acceptance.map((item) => {
    const revision = {
      ...item,
      revision: 1,
      state: "active",
    };
    return { ...revision, identity: acceptanceIdentity(ticket.ticket_id, revision) };
  });
  const contract = buildContractRevision(ticket.ticket_id, 1, acceptance);
  return {
    ...ticket,
    schema_version: 3,
    revision_state: "bound",
    acceptance,
    active_contract_revision: 1,
    contract_revisions: [contract],
  };
}

function sameAcceptanceSemantics(left, right) {
  return semanticDigest({
    criterion: left.criterion,
    authority: left.authority ?? "agent",
    derived_from: left.derived_from ?? [],
  }) === semanticDigest({
    criterion: right.criterion,
    authority: right.authority ?? "agent",
    derived_from: right.derived_from ?? [],
  });
}

// Canonical append/mutate path used by planners and the CLI. Semantic changes
// append immutable Acceptance and Contract revisions; selector and presentation
// changes remain outside the identities they select or describe.
export function appendTicketContractRevision(ticket, mutation = {}) {
  if (ticket.revision_state !== "bound") {
    throw new Error("legacy-pending Ticket must finish proof reconstruction before revision");
  }
  const acceptance = ticket.acceptance.map((item) => ({ ...item }));
  let contractChanged = false;
  const activeById = new Map(acceptance
    .filter((item) => item.state === "active")
    .map((item) => [item.acceptance_id, item]));

  for (const acceptanceId of mutation.retire_acceptance_ids ?? []) {
    const prior = activeById.get(acceptanceId);
    if (!prior) throw new Error(`cannot retire missing active Acceptance: ${acceptanceId}`);
    prior.state = "retired";
    activeById.delete(acceptanceId);
    contractChanged = true;
  }

  for (const change of mutation.acceptance_changes ?? []) {
    const prior = activeById.get(change.acceptance_id);
    if (prior && sameAcceptanceSemantics(prior, change)) {
      throw new Error(`${change.acceptance_id} has unchanged contract semantics; use presentation_changes`);
    }
    if (prior) {
      prior.state = "retired";
      activeById.delete(change.acceptance_id);
    }
    const previousRevisions = acceptance.filter((item) => item.acceptance_id === change.acceptance_id);
    const next = {
      acceptance_id: change.acceptance_id,
      revision: previousRevisions.length
        ? Math.max(...previousRevisions.map((item) => item.revision)) + 1
        : 1,
      criterion: change.criterion,
      state: "active",
      ...(change.authority === undefined ? {} : { authority: change.authority }),
      ...(change.derived_from === undefined ? {} : { derived_from: change.derived_from }),
      ...(change.presentation === undefined ? {} : { presentation: change.presentation }),
    };
    next.identity = acceptanceIdentity(ticket.ticket_id, next);
    acceptance.push(next);
    activeById.set(next.acceptance_id, next);
    contractChanged = true;
  }

  for (const change of mutation.presentation_changes ?? []) {
    const item = acceptance.find((candidate) =>
      candidate.acceptance_id === change.acceptance_id
      && candidate.revision === (change.revision ?? activeById.get(change.acceptance_id)?.revision));
    if (!item) throw new Error(`cannot present missing Acceptance revision: ${change.acceptance_id}`);
    if (change.presentation === null) delete item.presentation;
    else item.presentation = change.presentation;
  }

  if (!contractChanged) return { ...ticket, acceptance };
  const revision = ticket.active_contract_revision + 1;
  const contract = buildContractRevision(ticket.ticket_id, revision, acceptance);
  return {
    ...ticket,
    acceptance,
    active_contract_revision: revision,
    contract_revisions: [...ticket.contract_revisions, contract],
  };
}

export function activeAcceptance(ticket) {
  if (ticket.revision_state !== "bound") return [];
  return ticket.acceptance.filter((item) => item.state === "active");
}

export function activeContract(ticket) {
  if (ticket.revision_state !== "bound") return null;
  return ticket.contract_revisions.find(
    (item) => item.revision === ticket.active_contract_revision,
  ) ?? null;
}

export function activeAcceptanceReferenceMap(ticket) {
  return new Map(activeAcceptance(ticket).map((item) => [item.acceptance_id, acceptanceReference(item)]));
}

export function outcomeBindsContract(outcome, contract) {
  return outcome?.binding_state === "bound"
    && contract !== null
    && outcome.contract_revision?.revision === contract.revision
    && outcome.contract_revision?.identity === contract.identity;
}

export function evidenceBoundReferenceMap(evidence) {
  if (evidence?.binding_state !== "bound") return new Map();
  return new Map(evidence.acceptance_revisions.map((item) => [item.acceptance_id, item]));
}
