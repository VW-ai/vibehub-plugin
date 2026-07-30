import crypto from "node:crypto";
import path from "node:path";
import {
  isScalar,
  parseAllDocuments,
  stringify,
  visit,
  type Document,
  type ParsedNode,
} from "yaml";
import {
  TICKET_LEDGER_FORMAT,
  TICKET_LEDGER_MAX_BYTES,
  TICKET_LEDGER_MAX_RELATIONS,
  TICKET_LEDGER_MAX_TICKETS,
  TICKET_LEDGER_PROTOCOL_MAX_BYTES,
  TICKET_LEDGER_RELATIVE_PATH,
  TICKET_LEDGER_SCHEMA_VERSION,
  TICKET_LEDGER_TICKET_MAX_BYTES,
  TicketLedgerError,
  ticketDocumentSchema,
  ticketLedgerProtocolSchema,
  type TicketAcceptance,
  type TicketContextRef,
  type TicketDocument,
  type TicketLedgerCandidate,
  type TicketLedgerContent,
  type TicketLedgerProtocol,
  type TicketLedgerTicket,
  type TicketRelation,
} from "./contract.js";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export interface TicketLedgerFile {
  documentPath: string;
  bytes: Buffer;
}

export interface TicketLedgerPhysicalFile extends TicketLedgerFile {
  mode: number | string;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): Json => {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TicketLedgerError(
        "invalid_document",
        "Ticket ledger documents cannot contain non-finite numbers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new TicketLedgerError(
    "invalid_document",
    `Ticket ledger documents cannot contain ${typeof value} values`,
  );
};

export const canonicalTicketLedgerValue = (value: unknown): string =>
  JSON.stringify(canonicalize(value));

const compareText = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const YAML_CORE_TAGS = new Set([
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
]);

const normalizeText = (value: string): string =>
  value.replace(/\r\n?/gu, "\n").trim();

const uniqueBy = <T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
): void => {
  const seen = new Set<string>();
  for (const value of values) {
    const key = identity(value);
    if (seen.has(key)) {
      throw new TicketLedgerError(
        "invalid_document",
        `${label} contains duplicate identity ${key}`,
        { identity: key },
      );
    }
    seen.add(key);
  }
};

const normalizeAcceptance = (
  values: readonly TicketAcceptance[],
): TicketAcceptance[] => {
  const normalized = values.map((value) => ({
    acceptance_id: value.acceptance_id,
    criterion: normalizeText(value.criterion),
  }));
  uniqueBy(normalized, (value) => value.acceptance_id, "acceptance");
  return normalized.sort((left, right) =>
    compareText(left.acceptance_id, right.acceptance_id));
};

const normalizeContextRefs = (
  values: readonly TicketContextRef[],
): TicketContextRef[] => {
  const normalized = values.map((value) => ({
    ref: normalizeText(value.ref),
    purpose: normalizeText(value.purpose),
  }));
  uniqueBy(normalized, (value) => value.ref, "context_refs");
  return normalized.sort((left, right) => compareText(left.ref, right.ref));
};

const relationIdentityKey = (
  subjectTicketId: string,
  relation: Pick<TicketRelation, "type" | "target_ticket_id">,
): string =>
  `${subjectTicketId}\0${relation.type}\0${relation.target_ticket_id}`;

const normalizeRelations = (
  subjectTicketId: string,
  values: readonly TicketRelation[],
): TicketRelation[] => {
  const normalized = values.map((value) => ({
    type: value.type,
    target_ticket_id: value.target_ticket_id,
    ...(value.rationale === undefined
      ? {}
      : { rationale: normalizeText(value.rationale) }),
  }));
  uniqueBy(
    normalized,
    (value) => relationIdentityKey(subjectTicketId, value),
    "relations",
  );
  return normalized.sort((left, right) =>
    compareText(
      relationIdentityKey(subjectTicketId, left),
      relationIdentityKey(subjectTicketId, right),
    ));
};

const normalizeProvenanceRefs = (values: readonly string[]): string[] => {
  const normalized = values.map(normalizeText);
  uniqueBy(normalized, (value) => value, "provenance_refs");
  return normalized.sort(compareText);
};

const formatZodIssues = (
  issues: readonly { path: PropertyKey[]; message: string }[],
): string =>
  issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");

export const normalizeTicketDocument = (
  candidate: unknown,
  label = "Ticket document",
): TicketDocument => {
  const parsed = ticketDocumentSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `${label} is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label },
    );
  }
  const value = parsed.data;
  return {
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    kind: "ticket",
    ticket_id: value.ticket_id,
    outcome: normalizeText(value.outcome),
    context: normalizeText(value.context),
    acceptance: normalizeAcceptance(value.acceptance),
    constraints: value.constraints.map(normalizeText),
    context_refs: normalizeContextRefs(value.context_refs),
    relations: normalizeRelations(value.ticket_id, value.relations),
    provenance_refs: normalizeProvenanceRefs(value.provenance_refs),
  };
};

export const normalizeTicketLedgerProtocol = (
  candidate: unknown,
): TicketLedgerProtocol => {
  const parsed = ticketLedgerProtocolSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_document",
      `Ticket ledger protocol is invalid: ${formatZodIssues(parsed.error.issues)}`,
      { label: "protocol.yaml" },
    );
  }
  return parsed.data;
};

export const ticketDocumentPath = (ticketId: string): string => {
  const parsed = ticketDocumentSchema.shape.ticket_id.safeParse(ticketId);
  if (!parsed.success) {
    throw new TicketLedgerError(
      "invalid_path",
      `Invalid Ticket ID for document path: ${ticketId}`,
      { ticketId },
    );
  }
  return `${TICKET_LEDGER_RELATIVE_PATH}/tickets/${ticketId}.yaml`;
};

export const ticketRevision = (document: TicketDocument): string =>
  sha256(canonicalTicketLedgerValue(document));

export const encodeTicketDocument = (candidate: unknown): Buffer =>
  Buffer.from(
    stringify(normalizeTicketDocument(candidate), {
      lineWidth: 0,
      version: "1.2",
    }),
    "utf8",
  );

export const ticketLedgerInventoryDigest = (
  files: readonly TicketLedgerPhysicalFile[],
): string =>
  sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    kind: "ticket_ledger_physical_inventory",
    files: [...files]
      .sort((left, right) => compareText(left.documentPath, right.documentPath))
      .map((file) => ({
        document_path: file.documentPath,
        mode: String(file.mode),
        byte_digest: sha256(file.bytes),
    })),
  }));

const gitTreeMode = (mode: number | string): string => {
  if (typeof mode === "number") {
    return (mode & 0o111) === 0 ? "100644" : "100755";
  }
  return mode === "100755" ? "100755" : "100644";
};

export const ticketLedgerCheckpointInventoryDigest = (
  files: readonly TicketLedgerPhysicalFile[],
): string =>
  sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    kind: "ticket_ledger_git_checkpoint_inventory",
    files: [...files]
      .sort((left, right) => compareText(left.documentPath, right.documentPath))
      .map((file) => ({
        document_path: file.documentPath,
        git_mode: gitTreeMode(file.mode),
        byte_digest: sha256(file.bytes),
      })),
  }));

export const ticketRelationId = (
  subjectTicketId: string,
  relation: TicketRelation,
): string =>
  `trl-${sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    subject_ticket_id: subjectTicketId,
    type: relation.type,
    target_ticket_id: relation.target_ticket_id,
  }))}`;

const validateTicketGraph = (tickets: readonly TicketLedgerTicket[]): void => {
  const ids = new Set(tickets.map((ticket) => ticket.document.ticket_id));
  const dependencies = new Map<string, string[]>(
    tickets.map((ticket) => [ticket.document.ticket_id, []]),
  );

  for (const ticket of tickets) {
    const subjectId = ticket.document.ticket_id;
    const targets = dependencies.get(subjectId)!;
    for (const relation of ticket.document.relations) {
      const targetId = relation.target_ticket_id;
      if (subjectId === targetId) {
        throw new TicketLedgerError(
          "invalid_graph",
          `Ticket ${subjectId} cannot depend on itself`,
          { ticketId: subjectId },
        );
      }
      if (!ids.has(targetId)) {
        throw new TicketLedgerError(
          "invalid_graph",
          `Ticket ${subjectId} depends on missing Ticket ${targetId}`,
          { ticketId: subjectId, targetTicketId: targetId },
        );
      }
      targets.push(targetId);
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visitTicket = (ticketId: string): void => {
    const current = state.get(ticketId);
    if (current === "visited") return;
    if (current === "visiting") {
      const cycleStart = stack.indexOf(ticketId);
      const cycle = [...stack.slice(cycleStart), ticketId];
      throw new TicketLedgerError(
        "invalid_graph",
        `Ticket dependency cycle: ${cycle.join(" -> ")}`,
        { cycle },
      );
    }
    state.set(ticketId, "visiting");
    stack.push(ticketId);
    for (const dependency of dependencies.get(ticketId) ?? []) {
      visitTicket(dependency);
    }
    stack.pop();
    state.set(ticketId, "visited");
  };

  for (const ticketId of [...ids].sort(compareText)) visitTicket(ticketId);
};

export const validateTicketLedger = (
  candidate: TicketLedgerCandidate,
): TicketLedgerContent => {
  const protocol = normalizeTicketLedgerProtocol(candidate.protocol);
  if (candidate.tickets.length > TICKET_LEDGER_MAX_TICKETS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} Tickets`,
      { ticketCount: candidate.tickets.length },
    );
  }

  const tickets = candidate.tickets.map(({ documentPath, document }) => {
    const normalized = normalizeTicketDocument(document, documentPath);
    const expectedPath = ticketDocumentPath(normalized.ticket_id);
    if (documentPath !== expectedPath) {
      throw new TicketLedgerError(
        "invalid_path",
        `Ticket ${normalized.ticket_id} must be stored at ${expectedPath}`,
        { documentPath, expectedPath, ticketId: normalized.ticket_id },
      );
    }
    return {
      documentPath,
      ticketRevision: ticketRevision(normalized),
      document: normalized,
    };
  });

  uniqueBy(
    tickets,
    (ticket) => ticket.document.ticket_id,
    "Ticket ledger",
  );
  tickets.sort((left, right) =>
    compareText(left.document.ticket_id, right.document.ticket_id));
  const relationCount = tickets.reduce(
    (sum, ticket) => sum + ticket.document.relations.length,
    0,
  );
  if (relationCount > TICKET_LEDGER_MAX_RELATIONS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_RELATIONS} relations`,
      { relationCount },
    );
  }
  validateTicketGraph(tickets);

  const graphDigest = sha256(canonicalTicketLedgerValue({
    protocol,
    tickets: tickets.map((ticket) => ticket.document),
  }));
  return { protocol, tickets, graphDigest };
};

const parseYamlDocument = (
  bytes: Buffer,
  documentPath: string,
  maxBytes: number,
): unknown => {
  if (bytes.byteLength > maxBytes) {
    throw new TicketLedgerError(
      "file_too_large",
      `${documentPath} exceeds its ${maxBytes}-byte limit`,
      { documentPath, byteLength: bytes.byteLength, maxBytes },
    );
  }
  if (bytes.includes(0)) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} contains a NUL byte`,
      { documentPath },
    );
  }
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid UTF-8`,
      { documentPath },
    );
  }

  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(source, {
      version: "1.2",
      schema: "core",
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      merge: false,
      customTags: null,
      resolveKnownTags: false,
      prettyErrors: true,
    });
  } catch (cause) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid YAML 1.2`,
      { documentPath },
      { cause },
    );
  }
  if (documents.length !== 1) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} must contain exactly one YAML document`,
      { documentPath, documentCount: documents.length },
    );
  }
  const document = documents[0] as Document<ParsedNode, true>;
  if (document.errors.length > 0) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} is not valid YAML 1.2: ${document.errors
        .slice(0, 4)
        .map((error) => error.message)
        .join("; ")}`,
      { documentPath },
    );
  }

  let forbidden: string | null = null;
  visit(document, {
    Alias: () => {
      forbidden ??= "aliases";
    },
    Pair: (_key, pair) => {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        forbidden ??= "merge keys";
      }
    },
    Node: (_key, node) => {
      if (
        "tag" in node
        && typeof node.tag === "string"
        && !YAML_CORE_TAGS.has(node.tag)
      ) {
        forbidden ??= "custom tags";
      }
    },
  });
  if (forbidden !== null) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} contains forbidden YAML ${forbidden}`,
      { documentPath, forbidden },
    );
  }

  try {
    return document.toJS({ mapAsMap: false, maxAliasCount: 0 });
  } catch (cause) {
    throw new TicketLedgerError(
      "invalid_document",
      `${documentPath} cannot be converted into a safe value`,
      { documentPath },
      { cause },
    );
  }
};

export const decodeTicketLedger = (
  files: readonly TicketLedgerFile[],
): TicketLedgerContent => {
  const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > TICKET_LEDGER_MAX_BYTES) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger exceeds its ${TICKET_LEDGER_MAX_BYTES}-byte limit`,
      { totalBytes, maxBytes: TICKET_LEDGER_MAX_BYTES },
    );
  }

  const protocolPath = `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`;
  const protocolFiles = files.filter((file) => file.documentPath === protocolPath);
  if (protocolFiles.length !== 1) {
    throw new TicketLedgerError(
      "ledger_missing",
      `Ticket ledger must contain exactly one ${protocolPath}`,
      { protocolCount: protocolFiles.length },
    );
  }
  const protocol = parseYamlDocument(
    protocolFiles[0]!.bytes,
    protocolPath,
    TICKET_LEDGER_PROTOCOL_MAX_BYTES,
  );
  const ticketFiles = files.filter((file) => file.documentPath !== protocolPath);
  if (ticketFiles.length > TICKET_LEDGER_MAX_TICKETS) {
    throw new TicketLedgerError(
      "ledger_too_large",
      `Ticket ledger contains more than ${TICKET_LEDGER_MAX_TICKETS} files`,
      { ticketCount: ticketFiles.length },
    );
  }
  const tickets = ticketFiles.map((file) => ({
    documentPath: file.documentPath,
    document: parseYamlDocument(
      file.bytes,
      file.documentPath,
      TICKET_LEDGER_TICKET_MAX_BYTES,
    ),
  }));
  return validateTicketLedger({ protocol, tickets });
};

export const ticketLedgerSourceToken = (
  source:
    | {
      mode: "worktree";
      repositoryIncarnation: string;
      worktreeIdentity: string;
      resolvedCommit: string;
      graphDigest: string;
      inventoryDigest: string;
    }
    | {
      mode: "ref";
      repositoryIncarnation: string;
      resolvedCommit: string;
      graphDigest: string;
      inventoryDigest: string;
    },
): string =>
  `tls-${sha256(canonicalTicketLedgerValue({
    schema_version: TICKET_LEDGER_SCHEMA_VERSION,
    format: TICKET_LEDGER_FORMAT,
    ...source,
  }))}`;

export const isTicketLedgerDocumentPath = (
  repositoryRelativePath: string,
): boolean => {
  if (
    path.posix.normalize(repositoryRelativePath) !== repositoryRelativePath
    || repositoryRelativePath.startsWith("/")
  ) {
    return false;
  }
  if (repositoryRelativePath === `${TICKET_LEDGER_RELATIVE_PATH}/protocol.yaml`) {
    return true;
  }
  const prefix = `${TICKET_LEDGER_RELATIVE_PATH}/tickets/`;
  if (!repositoryRelativePath.startsWith(prefix)) return false;
  const fileName = repositoryRelativePath.slice(prefix.length);
  if (!fileName.endsWith(".yaml") || fileName.includes("/")) return false;
  try {
    return ticketDocumentPath(fileName.slice(0, -".yaml".length))
      === repositoryRelativePath;
  } catch {
    return false;
  }
};
