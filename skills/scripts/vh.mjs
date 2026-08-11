#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CONTEXT_TYPES = new Set([
  "intent",
  "decision",
  "constraint",
  "contract",
  "convention",
  "change",
  "note",
]);
const CONTEXT_STATES = new Set(["active", "superseded", "archived"]);
const OUTCOME_STATUSES = new Set([
  "successful",
  "partial",
  "failed",
  "deviated",
]);
const ACCEPTANCE_AUTHORITIES = new Set(["agent", "human"]);
const EVIDENCE_ORIGINS = new Set(["agent", "human"]);
const CONTEXT_RELATIONS = new Set([
  "relates_to",
  "depends_on",
  "supersedes",
]);
const CURRENT_PROJECT_FORMAT = 1;
const PROJECT_FORMAT_FILE = "version.yaml";

class VibeHubError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const positionals = [];
  let repo = process.cwd();
  let inputPath = null;
  let room = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") repo = argv[++index] ?? "";
    else if (value === "--input") inputPath = argv[++index] ?? "";
    else if (value === "--room") room = argv[++index] ?? "";
    else if (value.startsWith("--")) {
      throw new VibeHubError("invalid_argument", `Unknown argument: ${value}`);
    } else positionals.push(value);
  }
  if (!repo) throw new VibeHubError("invalid_argument", "--repo needs a path");
  if (positionals.length !== 2) {
    throw new VibeHubError(
      "invalid_argument",
      "Usage: vh.mjs <context|room|ticket|project> <operation> --repo <path> [--input <json>] [--room <path>]",
    );
  }
  if (room !== null && (room === "" || !room.split("/").every((segment) => ID.test(segment)))) {
    throw new VibeHubError("invalid_argument", "--room needs a slash-separated path of kebab-case room slugs");
  }
  return {
    domain: positionals[0],
    operation: positionals[1],
    repo: resolve(repo),
    inputPath,
    room,
  };
}

function readInput(inputPath) {
  if (!inputPath) return {};
  const source = inputPath === "-" ? readFileSync(0, "utf8") : readFileSync(inputPath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new VibeHubError(
      "invalid_input",
      `Input must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stable(value[key])]),
  );
}

function serialize(document) {
  // JSON is a strict YAML 1.2 subset. Keeping the persisted subset this small
  // lets an installed Skill validate and write it with Node alone.
  return `${JSON.stringify(stable(document), null, 2)}\n`;
}

function readDocument(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new VibeHubError("invalid_document", `Expected a regular file: ${path}`);
  }
  const source = readFileSync(path, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new VibeHubError(
      "invalid_document",
      `${path} must use VibeHub's JSON-compatible YAML subset: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function writeDocument(path, document) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, serialize(document), { flag: "wx" });
  renameSync(temporary, path);
}

function yamlFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => join(path, entry.name))
    .sort();
}

function nestedYamlFiles(path) {
  if (!existsSync(path)) return [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...nestedYamlFiles(child));
    else if (entry.isFile() && entry.name.endsWith(".yaml")) files.push(child);
  }
  return files.sort();
}

function dirs(repo) {
  return {
    root: join(repo, ".vibehub"),
    rooms: join(repo, ".vibehub", "rooms"),
    tickets: join(repo, ".vibehub", "tickets"),
    evidence: join(repo, ".vibehub", "evidence"),
    outcomes: join(repo, ".vibehub", "outcomes"),
  };
}

function projectFormatPath(repo) {
  return join(repo, ".vibehub", PROJECT_FORMAT_FILE);
}

function add(errors, path, message) {
  errors.push({ path, message });
}

function requiredString(errors, document, key, path, { id = false } = {}) {
  const value = document?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    add(errors, `${path}.${key}`, "must be a non-empty string");
  } else if (id && !ID.test(value)) {
    add(errors, `${path}.${key}`, "must be a lowercase kebab-case stable ID");
  }
}

function stringArray(errors, value, path, { nonEmpty = false, ids = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    add(errors, path, nonEmpty ? "must be a non-empty array" : "must be an array");
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") {
      add(errors, `${path}[${index}]`, "must be a non-empty string");
    } else {
      if (ids && !ID.test(item)) add(errors, `${path}[${index}]`, "must be a stable ID");
      if (seen.has(item)) add(errors, `${path}[${index}]`, "must be unique");
      seen.add(item);
    }
  });
}

function strictKeys(errors, document, allowed, path) {
  if (!isObject(document)) {
    add(errors, path, "must be an object");
    return false;
  }
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) add(errors, `${path}.${key}`, "is not allowed");
  }
  return true;
}

function validateProjectFormat(document, path = "project-format") {
  const errors = [];
  if (!strictKeys(
    errors,
    document,
    new Set(["schema_version", "kind", "format_version"]),
    path,
  )) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "vibehub_project") add(errors, `${path}.kind`, "must equal vibehub_project");
  if (!Number.isInteger(document.format_version) || document.format_version < 1) {
    add(errors, `${path}.format_version`, "must be a positive integer");
  }
  return errors;
}

function canonicalProjectFormat() {
  return {
    schema_version: 1,
    kind: "vibehub_project",
    format_version: CURRENT_PROJECT_FORMAT,
  };
}

function projectCompatibility(repo) {
  const path = projectFormatPath(repo);
  if (existsSync(path)) {
    let document;
    try {
      document = readDocument(path);
    } catch (error) {
      throw new VibeHubError(
        "validation_error",
        "Project format document is invalid",
        { errors: [{ path, message: error instanceof Error ? error.message : String(error) }] },
      );
    }
    const errors = validateProjectFormat(document, path);
    assertValid(errors, "Project format document is invalid");
    if (document.format_version > CURRENT_PROJECT_FORMAT) {
      return {
        state: "UNSUPPORTED_NEWER",
        current_format: document.format_version,
        target_format: CURRENT_PROJECT_FORMAT,
        detected_format: document.format_version,
        version_path: path,
        reason: "This repository was written by a newer VibeHub data format; use a compatible plugin version.",
      };
    }
    if (document.format_version < CURRENT_PROJECT_FORMAT) {
      return {
        state: "MIGRATION_REQUIRED",
        current_format: document.format_version,
        target_format: CURRENT_PROJECT_FORMAT,
        detected_format: document.format_version,
        version_path: path,
        reason: "This repository needs an explicit VibeHub data migration before writes are allowed.",
      };
    }
    return {
      state: "CURRENT",
      current_format: document.format_version,
      target_format: CURRENT_PROJECT_FORMAT,
      detected_format: document.format_version,
      version_path: path,
      reason: null,
    };
  }

  const paths = dirs(repo);
  const legacyContext = join(paths.root, "context");
  const initialized = existsSync(paths.root);
  const detectedFormat = yamlFiles(legacyContext).length > 0
    ? "0.4-unversioned"
    : initialized
      ? "0.5-unversioned"
      : "uninitialized";
  return {
    state: "MIGRATION_REQUIRED",
    current_format: null,
    target_format: CURRENT_PROJECT_FORMAT,
    detected_format: detectedFormat,
    version_path: path,
    reason: initialized
      ? "This repository predates the project format marker and needs an explicit migration before writes are allowed."
      : "This repository has not been initialized for VibeHub.",
  };
}

function assertCurrentProjectFormat(repo) {
  const compatibility = projectCompatibility(repo);
  if (compatibility.state !== "CURRENT") {
    throw new VibeHubError(
      "format_mismatch",
      compatibility.reason,
      { compatibility },
    );
  }
  return compatibility;
}

function validateContext(document, path = "context") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set([
        "schema_version",
        "kind",
        "context_id",
        "type",
        "state",
        "summary",
        "detail",
        "tags",
        "source",
        "evidence",
        "relations",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "context") add(errors, `${path}.kind`, "must equal context");
  requiredString(errors, document, "context_id", path, { id: true });
  if (!CONTEXT_TYPES.has(document.type)) add(errors, `${path}.type`, "is not a supported context type");
  if (!CONTEXT_STATES.has(document.state)) add(errors, `${path}.state`, "is not a supported context state");
  requiredString(errors, document, "summary", path);
  requiredString(errors, document, "detail", path);
  stringArray(errors, document.tags ?? [], `${path}.tags`);
  if (strictKeys(errors, document.source, new Set(["ref", "quote", "captured_at"]), `${path}.source`)) {
    requiredString(errors, document.source, "ref", `${path}.source`);
    requiredString(errors, document.source, "captured_at", `${path}.source`);
    if (Number.isNaN(Date.parse(document.source.captured_at))) {
      add(errors, `${path}.source.captured_at`, "must be an ISO-compatible date-time");
    }
    if (document.source.quote !== undefined && (typeof document.source.quote !== "string" || !document.source.quote.trim())) {
      add(errors, `${path}.source.quote`, "must be a non-empty string when present");
    }
  }
  if (!Array.isArray(document.evidence) || document.evidence.length === 0) {
    add(errors, `${path}.evidence`, "must contain at least one readable evidence item");
  } else {
    document.evidence.forEach((item, index) => {
      const itemPath = `${path}.evidence[${index}]`;
      if (strictKeys(errors, item, new Set(["ref", "note"]), itemPath)) {
        requiredString(errors, item, "ref", itemPath);
        requiredString(errors, item, "note", itemPath);
      }
    });
  }
  if (!Array.isArray(document.relations)) add(errors, `${path}.relations`, "must be an array");
  else document.relations.forEach((relation, index) => {
    const relationPath = `${path}.relations[${index}]`;
    if (strictKeys(errors, relation, new Set(["type", "target_context_id"]), relationPath)) {
      if (!CONTEXT_RELATIONS.has(relation.type)) add(errors, `${relationPath}.type`, "is not supported");
      requiredString(errors, relation, "target_context_id", relationPath, { id: true });
    }
  });
  return errors;
}

function validateRoom(document, path = "room") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set(["schema_version", "kind", "room_id", "description", "boundary", "anchors", "alignment", "stale", "stale_reason"]),
      path,
    )
  ) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "room") add(errors, `${path}.kind`, "must equal room");
  requiredString(errors, document, "room_id", path, { id: true });
  requiredString(errors, document, "description", path);
  requiredString(errors, document, "boundary", path);
  stringArray(errors, document.anchors ?? null, `${path}.anchors`);
  if (typeof document.stale !== "boolean") add(errors, `${path}.stale`, "must be a boolean");
  if (document.stale_reason !== undefined && (typeof document.stale_reason !== "string" || !document.stale_reason.trim())) {
    add(errors, `${path}.stale_reason`, "must be a non-empty string when present");
  }
  if (document.alignment !== undefined
    && strictKeys(errors, document.alignment, new Set(["last_aligned_commit", "checked_at", "anchor_hashes"]), `${path}.alignment`)) {
    requiredString(errors, document.alignment, "last_aligned_commit", `${path}.alignment`);
    requiredString(errors, document.alignment, "checked_at", `${path}.alignment`);
    if (Number.isNaN(Date.parse(document.alignment.checked_at))) {
      add(errors, `${path}.alignment.checked_at`, "must be an ISO-compatible date-time");
    }
    const hashes = document.alignment.anchor_hashes;
    if (!Array.isArray(hashes)) add(errors, `${path}.alignment.anchor_hashes`, "must be an array");
    else {
      const seen = new Set();
      hashes.forEach((item, index) => {
        const itemPath = `${path}.alignment.anchor_hashes[${index}]`;
        if (strictKeys(errors, item, new Set(["path", "blob"]), itemPath)) {
          requiredString(errors, item, "path", itemPath);
          requiredString(errors, item, "blob", itemPath);
          if (seen.has(item.path)) add(errors, `${itemPath}.path`, "must be unique");
          seen.add(item.path);
        }
      });
    }
  }
  return errors;
}

function validateTicket(document, path = "ticket") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set([
        "schema_version",
        "kind",
        "ticket_id",
        "maturity",
        "outcome",
        "context",
        "acceptance",
        "constraints",
        "context_refs",
        "relations",
        "provenance_refs",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "ticket") add(errors, `${path}.kind`, "must equal ticket");
  if (document.maturity !== undefined && !["firm", "draft"].includes(document.maturity)) {
    add(errors, `${path}.maturity`, "must equal firm or draft when present");
  }
  requiredString(errors, document, "ticket_id", path, { id: true });
  requiredString(errors, document, "outcome", path);
  requiredString(errors, document, "context", path);
  if (!Array.isArray(document.acceptance) || document.acceptance.length === 0) {
    add(errors, `${path}.acceptance`, "must contain at least one criterion");
  } else {
    const ids = new Set();
    document.acceptance.forEach((item, index) => {
      const itemPath = `${path}.acceptance[${index}]`;
      if (strictKeys(errors, item, new Set(["acceptance_id", "criterion", "authority"]), itemPath)) {
        requiredString(errors, item, "acceptance_id", itemPath, { id: true });
        requiredString(errors, item, "criterion", itemPath);
        if (item.authority !== undefined && !ACCEPTANCE_AUTHORITIES.has(item.authority)) {
          add(errors, `${itemPath}.authority`, "must equal agent or human when present");
        }
        if (ids.has(item.acceptance_id)) add(errors, `${itemPath}.acceptance_id`, "must be unique");
        ids.add(item.acceptance_id);
      }
    });
  }
  stringArray(errors, document.constraints, `${path}.constraints`);
  if (!Array.isArray(document.context_refs)) add(errors, `${path}.context_refs`, "must be an array");
  else document.context_refs.forEach((item, index) => {
    const itemPath = `${path}.context_refs[${index}]`;
    if (strictKeys(errors, item, new Set(["ref", "purpose"]), itemPath)) {
      requiredString(errors, item, "ref", itemPath);
      requiredString(errors, item, "purpose", itemPath);
    }
  });
  if (!Array.isArray(document.relations)) add(errors, `${path}.relations`, "must be an array");
  else document.relations.forEach((relation, index) => {
    const relationPath = `${path}.relations[${index}]`;
    if (strictKeys(errors, relation, new Set(["type", "target_ticket_id", "rationale"]), relationPath)) {
      if (relation.type !== "depends_on") add(errors, `${relationPath}.type`, "must equal depends_on");
      requiredString(errors, relation, "target_ticket_id", relationPath, { id: true });
      if (relation.rationale !== undefined && (typeof relation.rationale !== "string" || !relation.rationale.trim())) {
        add(errors, `${relationPath}.rationale`, "must be a non-empty string when present");
      }
    }
  });
  stringArray(errors, document.provenance_refs, `${path}.provenance_refs`);
  return errors;
}

function validateEvidence(document, path = "evidence") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set([
        "schema_version",
        "kind",
        "evidence_id",
        "ticket_id",
        "acceptance_ids",
        "summary",
        "refs",
        "origin",
        "recorded_at",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "ticket_evidence") add(errors, `${path}.kind`, "must equal ticket_evidence");
  requiredString(errors, document, "evidence_id", path, { id: true });
  requiredString(errors, document, "ticket_id", path, { id: true });
  stringArray(errors, document.acceptance_ids, `${path}.acceptance_ids`, { nonEmpty: true, ids: true });
  requiredString(errors, document, "summary", path);
  stringArray(errors, document.refs, `${path}.refs`, { nonEmpty: true });
  if (document.origin !== undefined && !EVIDENCE_ORIGINS.has(document.origin)) {
    add(errors, `${path}.origin`, "must equal agent or human when present");
  }
  requiredString(errors, document, "recorded_at", path);
  if (Number.isNaN(Date.parse(document.recorded_at))) add(errors, `${path}.recorded_at`, "must be an ISO-compatible date-time");
  return errors;
}

function validateOutcome(document, path = "outcome") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set([
        "schema_version",
        "kind",
        "ticket_id",
        "status",
        "accepted_acceptance_ids",
        "unresolved_acceptance_ids",
        "evidence_ids",
        "summary",
        "closed_at",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== 1) add(errors, `${path}.schema_version`, "must equal 1");
  if (document.kind !== "ticket_outcome") add(errors, `${path}.kind`, "must equal ticket_outcome");
  requiredString(errors, document, "ticket_id", path, { id: true });
  if (!OUTCOME_STATUSES.has(document.status)) add(errors, `${path}.status`, "is not supported");
  stringArray(errors, document.accepted_acceptance_ids, `${path}.accepted_acceptance_ids`, { ids: true });
  stringArray(errors, document.unresolved_acceptance_ids, `${path}.unresolved_acceptance_ids`, { ids: true });
  stringArray(errors, document.evidence_ids, `${path}.evidence_ids`, { ids: true });
  requiredString(errors, document, "summary", path);
  requiredString(errors, document, "closed_at", path);
  if (Number.isNaN(Date.parse(document.closed_at))) add(errors, `${path}.closed_at`, "must be an ISO-compatible date-time");
  return errors;
}

function loadMap(files, idField, validator, label) {
  const documents = new Map();
  const errors = [];
  for (const path of files) {
    let document;
    try {
      document = readDocument(path);
    } catch (error) {
      add(errors, path, error instanceof Error ? error.message : String(error));
      continue;
    }
    errors.push(...validator(document, path));
    const id = document?.[idField];
    if (typeof id === "string") {
      if (documents.has(id)) add(errors, path, `duplicate ${label} ID: ${id}`);
      else documents.set(id, { document, path });
      const expectedName = `${id}.yaml`;
      if (!path.endsWith(`/${expectedName}`)) add(errors, path, `filename must be ${expectedName}`);
    }
  }
  return { documents, errors };
}

const ROOM_FILE = "room.yaml";

// Rooms are directories: the path carries containment, room.yaml carries the
// room's own description. Every other .yaml inside a room is a Context entry.
function loadRooms(roomsPath) {
  const documents = new Map();
  const errors = [];
  const contextFiles = [];
  if (!existsSync(roomsPath)) return { documents, errors, contextFiles };
  const walk = (path, roomPath) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!ID.test(entry.name)) add(errors, child, "room directory must be a lowercase kebab-case slug");
        if (!existsSync(join(child, ROOM_FILE))) add(errors, child, `room directory must contain ${ROOM_FILE}`);
        walk(child, roomPath ? `${roomPath}/${entry.name}` : entry.name);
      } else if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      } else if (!roomPath) {
        add(errors, child, "documents must live inside a room directory, not directly under rooms/");
      } else if (entry.name === ROOM_FILE) {
        try {
          const document = readDocument(child);
          errors.push(...validateRoom(document, child));
          const slug = roomPath.split("/").at(-1);
          if (isObject(document) && document.room_id !== slug) {
            add(errors, child, `room_id must equal its directory name: ${slug}`);
          }
          documents.set(roomPath, { document, path: child });
        } catch (error) {
          add(errors, child, error instanceof Error ? error.message : String(error));
        }
      } else {
        contextFiles.push(child);
      }
    }
  };
  walk(roomsPath, "");
  contextFiles.sort();
  // Two rooms where neither contains the other must not claim the same
  // territory: overlapping anchors merge across branches without any git
  // conflict, so the defect has to be surfaced here.
  const entries = [...documents.entries()];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [pathA, roomA] = entries[left];
      const [pathB, roomB] = entries[right];
      if (pathA.startsWith(`${pathB}/`) || pathB.startsWith(`${pathA}/`)) continue;
      const overlapping = (Array.isArray(roomA.document?.anchors) ? roomA.document.anchors : [])
        .filter((anchorA) => (Array.isArray(roomB.document?.anchors) ? roomB.document.anchors : [])
          .some((anchorB) => {
            const a = anchorA.replace(/\/+$/u, "");
            const b = anchorB.replace(/\/+$/u, "");
            return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
          }));
      if (overlapping.length > 0) {
        add(errors, roomA.path, `rooms ${pathA} and ${pathB} claim overlapping territory (${overlapping.join(", ")}); fuse or split them — two rooms must not own the same anchors`);
      }
    }
  }
  return { documents, errors, contextFiles };
}

function findCycle(tickets) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visiting.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    const ticket = tickets.get(id)?.document;
    for (const relation of ticket?.relations ?? []) {
      const cycle = visit(relation.target_ticket_id);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of tickets.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

export function loadRepository(repo, overrides = {}) {
  const paths = dirs(repo);
  const rooms = loadRooms(paths.rooms);
  const contexts = loadMap(rooms.contextFiles, "context_id", validateContext, "Context");
  const legacyContext = join(paths.root, "context");
  if (yamlFiles(legacyContext).length > 0) {
    add(rooms.errors, legacyContext, "every Context lives in a room now; migrate these entries into their owning rooms under .vibehub/rooms/");
  }
  const tickets = loadMap(yamlFiles(paths.tickets), "ticket_id", validateTicket, "Ticket");
  const evidence = loadMap(nestedYamlFiles(paths.evidence), "evidence_id", validateEvidence, "Evidence");
  const outcomes = loadMap(yamlFiles(paths.outcomes), "ticket_id", validateOutcome, "Outcome");
  for (const document of overrides.contexts ?? []) {
    contexts.documents.set(document.context_id, { document, path: `<candidate:${document.context_id}>` });
  }
  for (const document of overrides.tickets ?? []) {
    tickets.documents.set(document.ticket_id, { document, path: `<candidate:${document.ticket_id}>` });
  }
  for (const document of overrides.evidence ?? []) {
    evidence.documents.set(document.evidence_id, { document, path: `<candidate:${document.evidence_id}>` });
  }
  for (const document of overrides.outcomes ?? []) {
    outcomes.documents.set(document.ticket_id, { document, path: `<candidate:${document.ticket_id}>` });
  }
  const errors = [...rooms.errors, ...contexts.errors, ...tickets.errors, ...evidence.errors, ...outcomes.errors];
  for (const { document, path } of contexts.documents.values()) {
    for (const relation of document.relations ?? []) {
      if (!contexts.documents.has(relation.target_context_id)) {
        add(errors, path, `dangling Context relation: ${relation.target_context_id}`);
      }
    }
  }
  for (const { document, path } of tickets.documents.values()) {
    for (const contextRef of document.context_refs ?? []) {
      const ref = contextRef.ref;
      const target = typeof ref === "string" ? resolve(repo, ref) : "";
      if (
        typeof ref !== "string"
        || isAbsolute(ref)
        || (!target.startsWith(`${repo}${sep}`) && target !== repo)
        || !existsSync(target)
      ) {
        add(errors, path, `unreadable Ticket context ref: ${String(ref)}`);
      } else {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          add(errors, path, `Ticket context ref must be a regular file: ${ref}`);
        }
      }
    }
    for (const relation of document.relations ?? []) {
      if (!tickets.documents.has(relation.target_ticket_id)) {
        add(errors, path, `dangling Ticket dependency: ${relation.target_ticket_id}`);
      }
    }
  }
  const cycle = findCycle(tickets.documents);
  if (cycle) add(errors, ".vibehub/tickets", `dependency cycle: ${cycle.join(" -> ")}`);
  for (const { document, path } of evidence.documents.values()) {
    const ticket = tickets.documents.get(document.ticket_id)?.document;
    if (!ticket) {
      add(errors, path, `Evidence references missing Ticket: ${document.ticket_id}`);
      continue;
    }
    const acceptance = new Set(ticket.acceptance.map((item) => item.acceptance_id));
    for (const id of document.acceptance_ids) {
      if (!acceptance.has(id)) add(errors, path, `Evidence references missing acceptance: ${id}`);
    }
  }
  for (const { document, path } of outcomes.documents.values()) {
    const ticket = tickets.documents.get(document.ticket_id)?.document;
    if (!ticket) {
      add(errors, path, `Outcome references missing Ticket: ${document.ticket_id}`);
      continue;
    }
    const acceptance = new Set(ticket.acceptance.map((item) => item.acceptance_id));
    const accepted = new Set(document.accepted_acceptance_ids);
    const unresolved = new Set(document.unresolved_acceptance_ids);
    for (const id of accepted) if (!acceptance.has(id)) add(errors, path, `Outcome accepts missing acceptance: ${id}`);
    for (const id of unresolved) if (!acceptance.has(id)) add(errors, path, `Outcome leaves missing acceptance unresolved: ${id}`);
    for (const id of accepted) if (unresolved.has(id)) add(errors, path, `Acceptance cannot be both accepted and unresolved: ${id}`);
    for (const id of acceptance) {
      if (!accepted.has(id) && !unresolved.has(id)) add(errors, path, `Outcome omits acceptance: ${id}`);
    }
    if (document.status === "successful" && (accepted.size !== acceptance.size || unresolved.size !== 0)) {
      add(errors, path, "successful Outcome must accept every criterion and leave none unresolved");
    }
    const referencedEvidence = document.evidence_ids.map((id) => evidence.documents.get(id)?.document);
    for (let index = 0; index < referencedEvidence.length; index += 1) {
      const item = referencedEvidence[index];
      if (!item) add(errors, path, `Outcome references missing Evidence: ${document.evidence_ids[index]}`);
      else if (item.ticket_id !== document.ticket_id) add(errors, path, `Outcome references Evidence for another Ticket: ${item.evidence_id}`);
    }
    for (const id of accepted) {
      const supportingEvidence = referencedEvidence.filter((item) =>
        item?.acceptance_ids.includes(id));
      if (supportingEvidence.length === 0) {
        add(errors, path, `Accepted criterion has no referenced Evidence: ${id}`);
      }
      const criterion = ticket.acceptance.find((item) => item.acceptance_id === id);
      if ((criterion?.authority ?? "agent") === "human"
        && !supportingEvidence.some((item) => (item.origin ?? "agent") === "human")) {
        add(errors, path, `Human-authority criterion has no referenced human-origin Evidence: ${id}`);
      }
    }
  }
  return { paths, rooms, contexts, tickets, evidence, outcomes, errors };
}

export function assertValid(errors, message = "VibeHub validation failed") {
  if (errors.length > 0) throw new VibeHubError("validation_error", message, { errors });
}

export function documents(map) {
  return [...map.values()].map((entry) => entry.document);
}

function initProject(repo) {
  const paths = dirs(repo);
  const compatibility = projectCompatibility(repo);
  if (
    compatibility.state !== "CURRENT"
    && compatibility.detected_format !== "uninitialized"
  ) {
    throw new VibeHubError(
      "format_mismatch",
      "Existing VibeHub data must be migrated explicitly; project init never upgrades it in place.",
      { compatibility },
    );
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  if (!existsSync(projectFormatPath(repo))) {
    writeDocument(projectFormatPath(repo), canonicalProjectFormat());
  }
  return {
    root: paths.root,
    format_version: CURRENT_PROJECT_FORMAT,
    version_path: projectFormatPath(repo),
    directories: [paths.rooms, paths.tickets, paths.evidence, paths.outcomes],
  };
}

function contextOperation(operation, repo, input, options = {}) {
  if (operation === "put") {
    assertCurrentProjectFormat(repo);
    const errors = validateContext(input);
    assertValid(errors, "Context document is invalid");
    if (!options.room) {
      throw new VibeHubError("invalid_input", "every Context lives in a room; pass --room with the lowest room that owns this claim");
    }
    const repository = loadRepository(repo, { contexts: [input] });
    assertValid(repository.errors);
    if (!repository.rooms.documents.has(options.room)) {
      throw new VibeHubError("not_found", `Room not found: ${options.room}`);
    }
    const directory = join(repository.paths.rooms, ...options.room.split("/"));
    const path = join(directory, `${input.context_id}.yaml`);
    const existing = repository.rooms.contextFiles
      .find((file) => file.endsWith(`${sep}${input.context_id}.yaml`));
    if (existing && existing !== path) {
      throw new VibeHubError(
        "invalid_input",
        `Context ${input.context_id} already lives at ${existing}; move it with git, not context put`,
      );
    }
    writeDocument(path, input);
    return { status: "written", context_id: input.context_id, room: options.room ?? null, path };
  }
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  if (operation === "validate") return { valid: true, context_count: repository.contexts.documents.size };
  if (operation === "get") {
    if (typeof input.context_id !== "string" || !ID.test(input.context_id)) {
      throw new VibeHubError("invalid_input", "context get needs a valid context_id");
    }
    const item = repository.contexts.documents.get(input.context_id)?.document;
    if (!item) throw new VibeHubError("not_found", `Context not found: ${input.context_id}`);
    return item;
  }
  if (operation === "query") {
    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
    const requested = Array.isArray(input.context_ids) ? new Set(input.context_ids) : null;
    const includeInactive = input.include_inactive === true;
    let scope = null;
    if (options.room) {
      if (!repository.rooms.documents.has(options.room)) {
        throw new VibeHubError("not_found", `Room not found: ${options.room}`);
      }
      scope = join(repository.paths.rooms, ...options.room.split("/")) + sep;
    }
    const matches = [...repository.contexts.documents.values()]
      .filter(({ document: item, path }) => {
        if (scope && !path.startsWith(scope)) return false;
        if (!includeInactive && item.state !== "active") return false;
        if (requested && !requested.has(item.context_id)) return false;
        if (!query) return true;
        return [item.context_id, item.type, item.summary, item.detail, ...item.tags]
          .join("\n")
          .toLowerCase()
          .includes(query);
      })
      .map((entry) => entry.document);
    return { contexts: matches, count: matches.length };
  }
  throw new VibeHubError("unsupported_operation", `Unsupported context operation: ${operation}`);
}

export function ticketStatus(repository, ticket) {
  const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document;
  if (outcome?.status === "successful") return "DONE";
  const blocking = ticket.relations
    .map((relation) => relation.target_ticket_id)
    .filter((id) => repository.outcomes.documents.get(id)?.document.status !== "successful");
  if (blocking.length > 0) return "BLOCKED";
  // A draft can never become READY: it surfaces as REFINE until planning
  // rewrites its acceptance for real and marks the Ticket firm.
  return ticket.maturity === "draft" ? "REFINE" : "READY";
}

function ticketOperation(operation, repo, input) {
  if (operation === "apply") {
    assertCurrentProjectFormat(repo);
    if (!Array.isArray(input.tickets) || input.tickets.length === 0) {
      throw new VibeHubError("invalid_input", "ticket apply needs a non-empty tickets array");
    }
    const errors = input.tickets.flatMap((ticket, index) => validateTicket(ticket, `tickets[${index}]`));
    const ids = new Set();
    for (const ticket of input.tickets) {
      if (ids.has(ticket.ticket_id)) add(errors, "tickets", `duplicate candidate Ticket: ${ticket.ticket_id}`);
      ids.add(ticket.ticket_id);
    }
    assertValid(errors, "Ticket candidate is invalid");
    const repository = loadRepository(repo, { tickets: input.tickets });
    assertValid(repository.errors);
    const written = [];
    for (const ticket of input.tickets) {
      const path = join(repository.paths.tickets, `${ticket.ticket_id}.yaml`);
      writeDocument(path, ticket);
      written.push(path);
    }
    return { status: "written", ticket_ids: input.tickets.map((ticket) => ticket.ticket_id), paths: written };
  }
  if (operation === "evidence") {
    assertCurrentProjectFormat(repo);
    const errors = validateEvidence(input);
    assertValid(errors, "Evidence document is invalid");
    const repository = loadRepository(repo, { evidence: [input] });
    assertValid(repository.errors);
    const path = join(repository.paths.evidence, input.ticket_id, `${input.evidence_id}.yaml`);
    writeDocument(path, input);
    return { status: "written", evidence_id: input.evidence_id, path };
  }
  if (operation === "closeout") {
    assertCurrentProjectFormat(repo);
    const errors = validateOutcome(input);
    assertValid(errors, "Outcome document is invalid");
    const repository = loadRepository(repo, { outcomes: [input] });
    assertValid(repository.errors);
    const path = join(repository.paths.outcomes, `${input.ticket_id}.yaml`);
    writeDocument(path, input);
    return { status: "written", ticket_id: input.ticket_id, outcome_status: input.status, path };
  }
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  if (operation === "validate") {
    return {
      valid: true,
      ticket_count: repository.tickets.documents.size,
      evidence_count: repository.evidence.documents.size,
      outcome_count: repository.outcomes.documents.size,
    };
  }
  if (operation === "get") {
    if (typeof input.ticket_id !== "string" || !ID.test(input.ticket_id)) {
      throw new VibeHubError("invalid_input", "ticket get needs a valid ticket_id");
    }
    const item = repository.tickets.documents.get(input.ticket_id)?.document;
    if (!item) throw new VibeHubError("not_found", `Ticket not found: ${input.ticket_id}`);
    const ticketEvidence = documents(repository.evidence.documents).filter((entry) => entry.ticket_id === input.ticket_id);
    return {
      ticket: item,
      status: ticketStatus(repository, item),
      evidence: ticketEvidence,
      outcome: repository.outcomes.documents.get(input.ticket_id)?.document ?? null,
    };
  }
  if (operation === "graph" || operation === "frontier") {
    const items = documents(repository.tickets.documents).map((ticket) => ({
      ticket,
      status: ticketStatus(repository, ticket),
      blocking_ticket_ids: ticket.relations
        .map((relation) => relation.target_ticket_id)
        .filter((id) => repository.outcomes.documents.get(id)?.document.status !== "successful"),
      outcome: repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null,
    }));
    if (operation === "frontier") {
      const ready = items.filter((item) => item.status === "READY");
      return { ready, count: ready.length };
    }
    return { tickets: items, count: items.length };
  }
  throw new VibeHubError("unsupported_operation", `Unsupported ticket operation: ${operation}`);
}

function git(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new VibeHubError("git_error", `git is unavailable: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new VibeHubError("git_error", `git ${args[0]} failed: ${(result.stderr || "").trim()}`);
  }
  return result;
}

// Anchors are path prefixes matched on whole segments: "src/auth" covers
// src/auth and src/auth/**, never src/authx.
function anchorMatches(anchor, path) {
  const prefix = anchor.endsWith("/") ? anchor.slice(0, -1) : anchor;
  return path === prefix || path.startsWith(`${prefix}/`);
}

// One snapshot of path -> filter-clean blob hash: committed tree overlaid
// with the dirty working tree. Hashes are the drift ground truth; commits
// are provenance only, so this survives rebases, fresh clones, and gc.
function repoSnapshot(repo) {
  const snapshot = new Map();
  for (const entry of git(repo, ["ls-tree", "-r", "-z", "HEAD"]).stdout.split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [, type, hash] = entry.slice(0, tab).split(" ");
    if (type === "blob") snapshot.set(entry.slice(tab + 1), hash);
  }
  for (const entry of git(repo, ["status", "--porcelain", "-uall", "--no-renames", "-z"]).stdout.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    if (!existsSync(join(repo, path)) || !lstatSync(join(repo, path)).isFile()) snapshot.delete(path);
    else snapshot.set(path, git(repo, ["hash-object", `--path=${path}`, path]).stdout.trim());
  }
  return snapshot;
}

function anchoredFiles(document, snapshot) {
  const files = new Map();
  for (const [path, hash] of snapshot) {
    if ((document.anchors ?? []).some((anchor) => anchorMatches(anchor, path))) files.set(path, hash);
  }
  return files;
}

function headIsBehind(repo, baseline) {
  const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
  if (baseline === head) return false;
  return git(repo, ["merge-base", "--is-ancestor", "HEAD", baseline], { allowFailure: true }).status === 0;
}

function roomOperation(operation, repo, input, options = {}) {
  if (operation === "align" || operation === "stale") {
    assertCurrentProjectFormat(repo);
  }
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  if (operation === "drift") {
    if (repository.rooms.documents.size === 0) return { cold_start: true, rooms: [] };
    const snapshot = repoSnapshot(repo);
    const rooms = [...repository.rooms.documents.entries()].map(([roomPath, { document }]) => {
      if (document.stale === true) {
        let hashesMatch = null;
        if (document.alignment) {
          const current = anchoredFiles(document, snapshot);
          const recorded = new Map(document.alignment.anchor_hashes.map((item) => [item.path, item.blob]));
          hashesMatch = current.size === recorded.size
            && [...current].every(([path, blob]) => recorded.get(path) === blob);
        }
        return { room: roomPath, state: "STALE", reason: document.stale_reason ?? null, hashes_match: hashesMatch };
      }
      if (!document.alignment) return { room: roomPath, state: "UNKNOWN", reason: "never aligned" };
      if (headIsBehind(repo, document.alignment.last_aligned_commit)) {
        return {
          room: roomPath,
          state: "WARNING",
          reason: "checkout is older than the alignment baseline; never realign specs backwards",
        };
      }
      const current = anchoredFiles(document, snapshot);
      const recorded = new Map(document.alignment.anchor_hashes.map((item) => [item.path, item.blob]));
      const changed = [...current].filter(([path, hash]) => recorded.has(path) && recorded.get(path) !== hash).map(([path]) => path);
      const added = [...current.keys()].filter((path) => !recorded.has(path));
      const deleted = [...recorded.keys()].filter((path) => !current.has(path));
      if (changed.length || added.length || deleted.length) {
        return { room: roomPath, state: "DRIFTED", changed, added, deleted };
      }
      return { room: roomPath, state: "FRESH" };
    });
    return { cold_start: false, rooms };
  }
  const entry = repository.rooms.documents.get(options.room ?? "");
  if (!entry) throw new VibeHubError("not_found", `Room not found: ${options.room ?? "(missing --room)"}`);
  if (operation === "align") {
    if (entry.document.alignment && headIsBehind(repo, entry.document.alignment.last_aligned_commit)) {
      throw new VibeHubError("invalid_state", "checkout is older than the alignment baseline; refusing to realign backwards");
    }
    const files = anchoredFiles(entry.document, repoSnapshot(repo));
    const document = {
      ...entry.document,
      alignment: {
        last_aligned_commit: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
        checked_at: new Date().toISOString(),
        anchor_hashes: [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, blob]) => ({ path, blob })),
      },
      stale: false,
    };
    delete document.stale_reason;
    writeDocument(entry.path, document);
    return { room: options.room, aligned_files: files.size, last_aligned_commit: document.alignment.last_aligned_commit };
  }
  if (operation === "stale") {
    if (typeof input.reason !== "string" || !input.reason.trim()) {
      throw new VibeHubError("invalid_input", "room stale needs a non-empty reason");
    }
    writeDocument(entry.path, { ...entry.document, stale: true, stale_reason: input.reason });
    return { room: options.room, state: "STALE", reason: input.reason };
  }
  throw new VibeHubError("unsupported_operation", `Unsupported room operation: ${operation}`);
}

function projectOperation(operation, repo) {
  if (operation === "init") return initProject(repo);
  if (operation === "compatibility") return projectCompatibility(repo);
  if (operation === "validate") {
    const compatibility = assertCurrentProjectFormat(repo);
    const repository = loadRepository(repo);
    assertValid(repository.errors);
    return {
      valid: true,
      format_version: compatibility.current_format,
      rooms: repository.rooms.documents.size,
      contexts: repository.contexts.documents.size,
      tickets: repository.tickets.documents.size,
      evidence: repository.evidence.documents.size,
      outcomes: repository.outcomes.documents.size,
    };
  }
  throw new VibeHubError("unsupported_operation", `Unsupported project operation: ${operation}`);
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.repo)) throw new VibeHubError("not_found", `Repository path does not exist: ${args.repo}`);
  const input = readInput(args.inputPath);
  let data;
  if (args.domain === "context") data = contextOperation(args.operation, args.repo, input, { room: args.room });
  else if (args.domain === "room") data = roomOperation(args.operation, args.repo, input, { room: args.room });
  else if (args.domain === "ticket") data = ticketOperation(args.operation, args.repo, input);
  else if (args.domain === "project") data = projectOperation(args.operation, args.repo, input);
  else throw new VibeHubError("unsupported_domain", `Unsupported domain: ${args.domain}`);
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    run();
  } catch (error) {
    const normalized = error instanceof VibeHubError
      ? error
      : new VibeHubError("internal_error", error instanceof Error ? error.message : String(error));
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: { code: normalized.code, message: normalized.message, details: normalized.details },
      })}\n`,
    );
    process.exitCode = 1;
  }
}
