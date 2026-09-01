#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
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
const VERSION_CONTRACT = JSON.parse(readFileSync(
  fileURLToPath(new URL("../contracts/versions.json", import.meta.url)),
  "utf8",
));
const DEPENDENCY_HYGIENE = JSON.parse(readFileSync(
  fileURLToPath(new URL("../contracts/dependency-hygiene.json", import.meta.url)),
  "utf8",
));
const CURRENT_PROJECT_FORMAT = VERSION_CONTRACT.project_format;
const CURRENT_TICKET_SCHEMA = VERSION_CONTRACT.document_schemas.ticket;
const PROJECT_FORMAT_FILE = "version.yaml";
const PULL_REQUEST_REF = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u;
const COMMIT_REF = /^commit:[0-9a-f]{40}$/u;
const COMMIT_HASH = /^[0-9a-f]{40}$/u;

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
  const rooms = [];
  let scope = null;
  let delivery = null;
  let path = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") repo = argv[++index] ?? "";
    else if (value === "--input") inputPath = argv[++index] ?? "";
    else if (value === "--path") path = argv[++index] ?? "";
    else if (value === "--room") {
      room = argv[++index] ?? "";
      rooms.push(room);
    }
    else if (value === "--scope") scope = argv[++index] ?? "";
    else if (value === "--delivery") delivery = argv[++index] ?? "";
    else if (value.startsWith("--")) {
      throw new VibeHubError("invalid_argument", `Unknown argument: ${value}`);
    } else positionals.push(value);
  }
  if (!repo) throw new VibeHubError("invalid_argument", "--repo needs a path");
  if (positionals.length !== 2) {
    throw new VibeHubError(
      "invalid_argument",
      "Usage: vh.mjs <context|room|ticket|project|source|skills> <operation> --repo <path> [--input <json>] [--scope <current|all>] [--delivery <canonical-ref>] [--room <path>]... [--path <file>]",
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
    rooms,
    scope,
    delivery,
    path,
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

// Unverifiable is not failure. A closed Ticket's context ref that cannot be
// checked because git is absent, the clone is shallow, or the commit was
// garbage-collected is reported so a human can see it, but it does not fail
// validation: failing would reintroduce exactly the brittleness this split
// removes — a checked-in record would once again depend on the ambient
// environment (git on PATH, full history) rather than on its own content.
function addUnverifiable(unverifiable, path, message) {
  unverifiable.push({ path, message });
}

// git that never throws and never inherits stdio: absent from PATH, a
// non-repository directory, and an unknown revision all return null. Callers
// treat null as "cannot verify", never as "verified absent".
function gitQuiet(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/u;

// True only when <commit>:<path> is a readable regular file (blob) at that
// commit. Anything else — missing commit, missing path, a tree — is false.
function blobExistsAt(repo, commit, path) {
  return (gitQuiet(repo, ["cat-file", "-t", `${commit}:${path}`]) ?? "").trim() === "blob";
}

// Which commit is "the commit recorded for this Ticket"? Three sources exist
// in this repository's own data, and they are tried in this order:
//
//   1. `commit:<sha>` entries in the Ticket's provenance_refs — the most
//      explicit statement anyone made about which commit this Ticket concerns.
//   2. `delivered_commit` on the Ticket's deliveries — the commit the delivery
//      actually landed as.
//   3. The commit that recorded the Ticket's Outcome, from git's own history of
//      .vibehub/outcomes/<id>.yaml.
//
// (3) is the load-bearing one and is deliberately last-resort-but-universal:
// the Outcome schema has no commit field at all, and most closed Tickets here
// carry neither a provenance commit nor a delivered_commit. (3) is also the
// most defensible source available: it is git's own record of the tree as it
// stood at the moment the Ticket was closed, it exists for every genuinely
// closed and committed Ticket, and it requires editing no checked-in document
// to come into being.
function ticketCommitResolver(repo) {
  const cache = new Map();
  return (document) => {
    const id = document.ticket_id;
    if (cache.has(id)) return cache.get(id);
    const candidates = [];
    for (const provenance of document.provenance_refs ?? []) {
      if (typeof provenance !== "string" || !provenance.startsWith("commit:")) continue;
      // Provenance may point at one path inside a commit: "commit:<sha>:<path>".
      const sha = provenance.slice("commit:".length).split(":")[0];
      if (COMMIT_SHA.test(sha)) candidates.push(sha);
    }
    for (const delivery of document.deliveries ?? []) {
      const sha = delivery?.delivered_commit;
      if (typeof sha === "string" && COMMIT_SHA.test(sha)) candidates.push(sha);
    }
    const outcomePath = `.vibehub/outcomes/${id}.yaml`;
    const closeout = (gitQuiet(repo, ["log", "-1", "--format=%H", "--", outcomePath]) ?? "").trim();
    if (COMMIT_SHA.test(closeout)) candidates.push(closeout);
    // Keep only commits this checkout can actually read: a shallow clone or a
    // dropped object turns a candidate into "unverifiable", not into a failure.
    const readable = [];
    for (const sha of candidates) {
      if (readable.includes(sha)) continue;
      if (gitQuiet(repo, ["cat-file", "-e", `${sha}^{commit}`]) !== null) readable.push(sha);
    }
    cache.set(id, readable);
    return readable;
  };
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
      new Set(["schema_version", "kind", "room_id", "description", "boundary", "anchors", "alignment", "stale", "stale_reason", "coverage_exceptions"]),
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
  // A segment that yields no Context is a decision, not an omission: the room
  // that owns the anchor records the segment id and the stated reason. Optional
  // so every room written before this field existed still validates.
  if (document.coverage_exceptions !== undefined) {
    if (!Array.isArray(document.coverage_exceptions)) {
      add(errors, `${path}.coverage_exceptions`, "must be an array when present");
    } else {
      const seen = new Set();
      document.coverage_exceptions.forEach((item, index) => {
        const itemPath = `${path}.coverage_exceptions[${index}]`;
        if (strictKeys(errors, item, new Set(["segment", "reason"]), itemPath)) {
          requiredString(errors, item, "segment", itemPath);
          requiredString(errors, item, "reason", itemPath);
          if (typeof item.segment === "string") {
            if (seen.has(item.segment)) add(errors, `${itemPath}.segment`, "must be unique");
            seen.add(item.segment);
          }
        }
      });
    }
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
        "deliveries",
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
  if (document.schema_version !== CURRENT_TICKET_SCHEMA) {
    add(errors, `${path}.schema_version`, `must equal ${CURRENT_TICKET_SCHEMA}`);
  }
  if (document.kind !== "ticket") add(errors, `${path}.kind`, "must equal ticket");
  if (document.maturity !== undefined && !["firm", "draft"].includes(document.maturity)) {
    add(errors, `${path}.maturity`, "must equal firm or draft when present");
  }
  requiredString(errors, document, "ticket_id", path, { id: true });
  requiredString(errors, document, "outcome", path);
  if (!Array.isArray(document.deliveries)) {
    add(errors, `${path}.deliveries`, "must be an array");
  } else {
      const refs = new Set();
      document.deliveries.forEach((delivery, index) => {
        const deliveryPath = `${path}.deliveries[${index}]`;
        const allowed = new Set(["kind", "ref", "state", "delivered_at", "delivered_commit", "reverted_by"]);
        if (!strictKeys(errors, delivery, allowed, deliveryPath)) return;
        requiredString(errors, delivery, "kind", deliveryPath);
        requiredString(errors, delivery, "ref", deliveryPath);
        requiredString(errors, delivery, "state", deliveryPath);
        const delivered = delivery.state === "delivered";
        if (delivery.kind === "pull_request") {
          if (!PULL_REQUEST_REF.test(delivery.ref ?? "")) add(errors, `${deliveryPath}.ref`, "must be a canonical GitHub pull request URL");
          if (!["proposed", "delivered", "abandoned"].includes(delivery.state)) add(errors, `${deliveryPath}.state`, "must equal proposed, delivered, or abandoned");
        } else if (delivery.kind === "cherry_pick") {
          if (!COMMIT_REF.test(delivery.ref ?? "")) add(errors, `${deliveryPath}.ref`, "must equal commit:<40-hex>");
          if (!delivered) add(errors, `${deliveryPath}.state`, "cherry_pick must be delivered");
        } else add(errors, `${deliveryPath}.kind`, "must equal pull_request or cherry_pick");
        if (delivered) {
          requiredString(errors, delivery, "delivered_at", deliveryPath);
          if (delivery.delivered_at && Number.isNaN(Date.parse(delivery.delivered_at))) add(errors, `${deliveryPath}.delivered_at`, "must be an ISO-compatible date-time");
          if (!COMMIT_HASH.test(delivery.delivered_commit ?? "")) add(errors, `${deliveryPath}.delivered_commit`, "must be 40 lowercase hex characters");
          if (delivery.reverted_by !== undefined && !COMMIT_REF.test(delivery.reverted_by)) add(errors, `${deliveryPath}.reverted_by`, "must equal commit:<40-hex>");
        } else {
          for (const field of ["delivered_at", "delivered_commit", "reverted_by"]) {
            if (delivery[field] !== undefined) add(errors, `${deliveryPath}.${field}`, "is allowed only for delivered entries");
          }
        }
        if (refs.has(delivery.ref)) add(errors, `${deliveryPath}.ref`, "must be unique per Ticket");
        refs.add(delivery.ref);
      });
  }
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
  const unverifiable = [];
  for (const { document, path } of contexts.documents.values()) {
    for (const relation of document.relations ?? []) {
      if (!contexts.documents.has(relation.target_context_id)) {
        add(errors, path, `dangling Context relation: ${relation.target_context_id}`);
      }
    }
  }
  const recordedCommits = ticketCommitResolver(repo);
  for (const { document, path } of tickets.documents.values()) {
    const closed = outcomes.documents.has(document.ticket_id);
    for (const contextRef of document.context_refs ?? []) {
      const ref = contextRef.ref;
      const target = typeof ref === "string" ? resolve(repo, ref) : "";
      const wellFormed = typeof ref === "string"
        && !isAbsolute(ref)
        && (target.startsWith(`${repo}${sep}`) || target === repo);
      if (wellFormed && existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          add(errors, path, `Ticket context ref must be a regular file: ${ref}`);
        }
        continue;
      }
      // An OPEN Ticket's context_refs are a live pointer: it is about to be
      // executed, so every ref must be readable in the working tree. A
      // malformed or escaping ref is never a record either.
      if (!wellFormed || !closed) {
        add(errors, path, `unreadable Ticket context ref: ${String(ref)}`);
        continue;
      }
      // A CLOSED Ticket's context_refs are a record of what was read when the
      // work was done, not a claim about today's directory layout. Resolve
      // them against a commit recorded for that Ticket instead.
      const commits = recordedCommits(document);
      if (commits.length === 0) {
        addUnverifiable(
          unverifiable,
          path,
          `unverifiable Ticket context ref: ${ref} (closed Ticket; no recorded commit is readable here)`,
        );
        continue;
      }
      const commit = commits.find((candidate) => blobExistsAt(repo, candidate, ref));
      if (!commit) {
        add(
          errors,
          path,
          `unreadable Ticket context ref: ${ref} (absent from the working tree and from recorded commit ${commits[0].slice(0, 8)})`,
        );
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
  return { paths, rooms, contexts, tickets, evidence, outcomes, errors, unverifiable };
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
  if (operation === "coverage") return contextCoverage(repo, repository, options.room ?? null);
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

function acceptanceAuthority(criterion) {
  return criterion.authority ?? "agent";
}

function evidenceOrigin(evidence) {
  return evidence.origin ?? "agent";
}

export function ticketNextAction(repository, ticket) {
  const acceptanceIds = ticket.acceptance.map((criterion) => criterion.acceptance_id);
  const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null;
  if (outcome?.status === "successful") {
    return {
      action: "DONE",
      reason: "successful_outcome",
      detail: "An independent successful Outcome accepts every current criterion.",
      acceptance_ids: acceptanceIds,
      blocking_ticket_ids: [],
    };
  }
  if (outcome) {
    return {
      action: "REPLAN",
      reason: "non_successful_outcome",
      detail: `The independent Outcome is ${outcome.status}; revise the Ticket before another execution cycle.`,
      acceptance_ids: outcome.unresolved_acceptance_ids,
      blocking_ticket_ids: [],
    };
  }

  const blockingTicketIds = ticket.relations
    .map((relation) => relation.target_ticket_id)
    .filter((id) => repository.outcomes.documents.get(id)?.document.status !== "successful")
    .sort();
  if (blockingTicketIds.length > 0) {
    return {
      action: "WAIT",
      reason: "unresolved_direct_dependencies",
      detail: "Direct prerequisites must close successfully before this Ticket can advance.",
      acceptance_ids: [],
      blocking_ticket_ids: blockingTicketIds,
    };
  }

  if (ticket.maturity === "draft") {
    return {
      action: "REFINE",
      reason: "draft_contract",
      detail: "The unblocked draft needs a firm, executable acceptance contract.",
      acceptance_ids: acceptanceIds,
      blocking_ticket_ids: [],
    };
  }

  const ticketEvidence = documents(repository.evidence.documents)
    .filter((evidence) => evidence.ticket_id === ticket.ticket_id);
  const evidencedIds = new Set(ticketEvidence.flatMap((evidence) => evidence.acceptance_ids));
  const humanEvidencedIds = new Set(ticketEvidence
    .filter((evidence) => evidenceOrigin(evidence) === "human")
    .flatMap((evidence) => evidence.acceptance_ids));
  const missingAgentIds = ticket.acceptance
    .filter((criterion) => acceptanceAuthority(criterion) !== "human"
      && !evidencedIds.has(criterion.acceptance_id))
    .map((criterion) => criterion.acceptance_id);
  if (missingAgentIds.length > 0) {
    return {
      action: "EXECUTE",
      reason: "acceptance_evidence_incomplete",
      detail: "Agent-authority criteria still need reproducible acceptance-linked Evidence; human authority is routed once it is the remaining blocker.",
      acceptance_ids: missingAgentIds,
      blocking_ticket_ids: [],
    };
  }

  const missingHumanIds = ticket.acceptance
    .filter((criterion) => acceptanceAuthority(criterion) === "human"
      && !humanEvidencedIds.has(criterion.acceptance_id))
    .map((criterion) => criterion.acceptance_id);
  if (missingHumanIds.length > 0) {
    return {
      action: "NEEDS_HUMAN",
      reason: "missing_human_evidence",
      detail: "Every agent-authority criterion is evidenced; the reachable human-authority criteria still need explicit human-origin Evidence.",
      acceptance_ids: missingHumanIds,
      blocking_ticket_ids: [],
    };
  }

  // Every agent-authority criterion is evidenced and every human-authority
  // criterion carries human-origin Evidence, so the contract is fully
  // satisfied and only independent adjudication remains.
  return {
    action: "CLOSE_OUT",
    reason: "authority_satisfying_evidence_complete",
    detail: "Every current criterion has authority-satisfying Evidence; independent adjudication is next.",
    acceptance_ids: acceptanceIds,
    blocking_ticket_ids: [],
  };
}

export function ticketArchived(repository, ticket) {
  if (!ticket) return false;
  const outcome = repository.outcomes.documents.get(ticket.ticket_id)?.document;
  return outcome?.status === "successful"
    && (ticket.deliveries ?? []).some((delivery) => delivery.state === "delivered");
}

function ticketDependencyKey(relation) {
  return `${relation.type}:${relation.target_ticket_id}`;
}

export function candidateDependencyAdvice(currentRepository, candidateRepository, candidates) {
  const advice = [];
  candidates.forEach((candidate, candidateIndex) => {
    const existing = currentRepository.tickets.documents.get(candidate.ticket_id)?.document;
    const existingEdges = new Set((existing?.relations ?? []).map(ticketDependencyKey));
    candidate.relations.forEach((relation, relationIndex) => {
      if (existingEdges.has(ticketDependencyKey(relation))) return;
      const target = candidateRepository.tickets.documents.get(relation.target_ticket_id)?.document;
      if (!target || ticketStatus(candidateRepository, target) !== "DONE") return;
      advice.push({
        code: DEPENDENCY_HYGIENE.candidate_done_dependency.advice_code,
        level: DEPENDENCY_HYGIENE.candidate_done_dependency.level,
        blocking: DEPENDENCY_HYGIENE.candidate_done_dependency.blocking,
        relation_path: `tickets[${candidateIndex}].relations[${relationIndex}]`,
        ticket_id: candidate.ticket_id,
        target_ticket_id: relation.target_ticket_id,
        rationale: relation.rationale ?? null,
        rationale_present: typeof relation.rationale === "string" && relation.rationale.trim() !== "",
        message: DEPENDENCY_HYGIENE.candidate_done_dependency.instruction,
        suggested_context_refs: [
          `.vibehub/tickets/${relation.target_ticket_id}.yaml`,
          `.vibehub/outcomes/${relation.target_ticket_id}.yaml`,
        ],
      });
    });
  });
  return advice.sort((left, right) =>
    left.ticket_id.localeCompare(right.ticket_id)
    || left.target_ticket_id.localeCompare(right.target_ticket_id)
    || left.relation_path.localeCompare(right.relation_path));
}

function ticketRoomPaths(ticket) {
  return ticket.context_refs.flatMap(({ ref }) => {
    const match = ref.match(/^\.vibehub\/rooms\/(.+)\/[^/]+\.yaml$/u);
    return match ? [match[1]] : [];
  });
}

function normalizeTicketQuery(repository, options = {}) {
  const scope = options.scope ?? "current";
  if (!new Set(["current", "all"]).has(scope)) {
    throw new VibeHubError("invalid_argument", "--scope must equal current or all");
  }
  const delivery = options.delivery ?? null;
  if (delivery !== null && !PULL_REQUEST_REF.test(delivery) && !COMMIT_REF.test(delivery)) {
    throw new VibeHubError("invalid_argument", "--delivery must be a canonical GitHub pull request URL or commit:<40-hex>");
  }
  const rooms = [...new Set(options.rooms ?? [])].sort();
  for (const room of rooms) {
    if (!repository.rooms.documents.has(room)) {
      throw new VibeHubError("invalid_argument", `Unknown Room filter: ${room}`);
    }
  }
  const historyIds = [...new Set(options.historyIds ?? [])].sort();
  for (const id of historyIds) {
    const ticket = repository.tickets.documents.get(id)?.document;
    if (!ticket || ticketStatus(repository, ticket) !== "DONE") {
      throw new VibeHubError("invalid_argument", `Unknown or non-DONE history Ticket: ${id}`);
    }
  }
  return { scope, delivery, rooms, historyIds };
}

export function projectTicketQuery(repository, options = {}) {
  const filters = normalizeTicketQuery(repository, options);
  const all = documents(repository.tickets.documents)
    .sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
  const matchesFilters = (ticket) => {
    if (filters.delivery !== null
      && !(ticket.deliveries ?? []).some((item) => item.ref === filters.delivery)) return false;
    if (filters.rooms.length > 0) {
      const ticketRooms = ticketRoomPaths(ticket);
      if (!ticketRooms.some((path) => filters.rooms.some((room) =>
        path === room || path.startsWith(`${room}/`)))) return false;
    }
    return true;
  };
  const base = all.filter((ticket) => matchesFilters(ticket)
    && (filters.scope === "all" || ticketStatus(repository, ticket) !== "DONE"));
  const visibleIds = new Set(base.map((ticket) => ticket.ticket_id));
  const baseIds = new Set(visibleIds);
  const relationDocuments = all.flatMap((ticket) => ticket.relations.map((relation) => ({
    prerequisite_ticket_id: relation.target_ticket_id,
    dependent_ticket_id: ticket.ticket_id,
    rationale: relation.rationale ?? "Direct execution dependency.",
  }))).sort((left, right) =>
    left.prerequisite_ticket_id.localeCompare(right.prerequisite_ticket_id)
    || left.dependent_ticket_id.localeCompare(right.dependent_ticket_id));
  if (filters.scope === "current") {
    for (const relation of relationDocuments) {
      const leftVisible = baseIds.has(relation.prerequisite_ticket_id);
      const rightVisible = baseIds.has(relation.dependent_ticket_id);
      const otherId = leftVisible && !rightVisible
        ? relation.dependent_ticket_id
        : rightVisible && !leftVisible
          ? relation.prerequisite_ticket_id
          : null;
      const other = otherId ? repository.tickets.documents.get(otherId)?.document : null;
      if (other && ticketStatus(repository, other) === "DONE") visibleIds.add(otherId);
    }
    for (const id of filters.historyIds) visibleIds.add(id);
  }
  const tickets = all.filter((ticket) => visibleIds.has(ticket.ticket_id));
  const relations = relationDocuments.filter((relation) =>
    visibleIds.has(relation.prerequisite_ticket_id)
    && visibleIds.has(relation.dependent_ticket_id));
  const stubs = [];
  if (filters.scope === "current") {
    for (const ticket of tickets) {
      for (const direction of ["upstream", "downstream"]) {
        const nextIds = relationDocuments.flatMap((relation) => {
          if (direction === "upstream" && relation.dependent_ticket_id === ticket.ticket_id) return [relation.prerequisite_ticket_id];
          if (direction === "downstream" && relation.prerequisite_ticket_id === ticket.ticket_id) return [relation.dependent_ticket_id];
          return [];
        }).filter((id) => {
          if (visibleIds.has(id)) return false;
          const candidate = repository.tickets.documents.get(id)?.document;
          return candidate && ticketStatus(repository, candidate) === "DONE";
        });
        if (!nextIds.length) continue;
        const hidden = new Set(nextIds);
        const queue = [...nextIds];
        while (queue.length) {
          const id = queue.shift();
          for (const relation of relationDocuments) {
            const next = direction === "upstream" && relation.dependent_ticket_id === id
              ? relation.prerequisite_ticket_id
              : direction === "downstream" && relation.prerequisite_ticket_id === id
                ? relation.dependent_ticket_id
                : null;
            if (!next || visibleIds.has(next) || hidden.has(next)) continue;
            const candidate = repository.tickets.documents.get(next)?.document;
            if (candidate && ticketStatus(repository, candidate) === "DONE") {
              hidden.add(next);
              queue.push(next);
            }
          }
        }
        stubs.push({
          stub_ref: `${ticket.ticket_id}:${direction}`,
          anchor_ticket_id: ticket.ticket_id,
          direction,
          hidden_ticket_count: hidden.size,
          next_ticket_ids: [...new Set(nextIds)].sort(),
        });
      }
    }
  }
  return { filters, tickets, relations, stubs };
}

function ticketOperation(operation, repo, input, options = {}) {
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
    const currentRepository = loadRepository(repo);
    assertValid(currentRepository.errors);
    const repository = loadRepository(repo, { tickets: input.tickets });
    assertValid(repository.errors);
    const advice = candidateDependencyAdvice(currentRepository, repository, input.tickets);
    const written = [];
    for (const ticket of input.tickets) {
      const path = join(repository.paths.tickets, `${ticket.ticket_id}.yaml`);
      writeDocument(path, ticket);
      written.push(path);
    }
    return {
      status: "written",
      ticket_ids: input.tickets.map((ticket) => ticket.ticket_id),
      paths: written,
      advice,
    };
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
      next_action: ticketNextAction(repository, item),
      evidence: ticketEvidence,
      outcome: repository.outcomes.documents.get(input.ticket_id)?.document ?? null,
    };
  }
  if (operation === "graph" || operation === "frontier") {
    const query = operation === "graph"
      ? projectTicketQuery(repository, options)
      : { tickets: documents(repository.tickets.documents), relations: [], stubs: [], filters: null };
    const items = query.tickets.map((ticket) => ({
      ticket,
      status: ticketStatus(repository, ticket),
      next_action: ticketNextAction(repository, ticket),
      archived: ticketArchived(repository, ticket),
      blocking_ticket_ids: ticket.relations
        .map((relation) => relation.target_ticket_id)
        .filter((id) => repository.outcomes.documents.get(id)?.document.status !== "successful"),
      outcome: repository.outcomes.documents.get(ticket.ticket_id)?.document ?? null,
    }));
    if (operation === "frontier") {
      const byAction = (action) => items
        .filter((item) => item.next_action.action === action)
        .sort((left, right) => left.ticket.ticket_id.localeCompare(right.ticket.ticket_id));
      const readyToExecute = byAction("EXECUTE");
      return {
        // Compatibility path for existing callers: `ready` still exists, but
        // now means genuinely ready to execute rather than merely status READY.
        ready: readyToExecute,
        ready_to_execute: readyToExecute,
        ready_to_closeout: byAction("CLOSE_OUT"),
        needs_human: byAction("NEEDS_HUMAN"),
        needs_replan: byAction("REPLAN"),
        needs_refinement: byAction("REFINE"),
        waiting: byAction("WAIT"),
        count: readyToExecute.length,
      };
    }
    return {
      tickets: items.sort((left, right) => left.ticket.ticket_id.localeCompare(right.ticket.ticket_id)),
      relations: query.relations,
      stubs: query.stubs,
      filters: query.filters,
      count: items.length,
    };
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

export function projectRoomDrift(repo, loadedRepository = null) {
  const repository = loadedRepository ?? loadRepository(repo);
  assertValid(repository.errors);
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

export function roomContextEntries(repository, roomPath) {
  const prefix = join(repository.paths.rooms, ...roomPath.split("/")) + sep;
  return [...repository.contexts.documents.values()]
    .filter((item) => item.path.startsWith(prefix))
    .sort((left, right) => left.document.context_id.localeCompare(right.document.context_id));
}

export function projectRoomTree(repo, loadedRepository = null) {
  const repository = loadedRepository ?? loadRepository(repo);
  assertValid(repository.errors);
  let drift;
  try {
    drift = projectRoomDrift(repo, repository);
  } catch (error) {
    if (error?.code !== "git_error") throw error;
    drift = {
      cold_start: true,
      rooms: [...repository.rooms.documents.keys()].map((room) => ({
        room,
        state: "UNKNOWN",
        reason: "Git snapshot unavailable",
      })),
    };
  }
  const driftByRoom = new Map(drift.rooms.map((item) => [item.room, item]));
  const rooms = [...repository.rooms.documents.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roomPath, entry]) => {
      const item = driftByRoom.get(roomPath) ?? { room: roomPath, state: "UNKNOWN", reason: "never aligned" };
      return {
        room: roomPath,
        room_id: entry.document.room_id,
        parent: roomPath.includes("/") ? roomPath.slice(0, roomPath.lastIndexOf("/")) : null,
        description: entry.document.description,
        boundary: entry.document.boundary,
        drift: item.state === "UNKNOWN" ? { ...item, state: "COLD_START" } : item,
        context_count: roomContextEntries(repository, roomPath).length,
      };
    });
  return { cold_start: drift.cold_start, rooms };
}

function roomOperation(operation, repo, input, options = {}) {
  if (operation === "align" || operation === "stale") {
    assertCurrentProjectFormat(repo);
  }
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  if (operation === "drift") {
    return projectRoomDrift(repo, repository);
  }
  if (operation === "tree") {
    return projectRoomTree(repo, repository);
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

// ---------------------------------------------------------------------------
// Source segmentation.
//
// Coverage can only be *recomputed* if segmentation is reproducible, so every
// rule below is a pure function of the file's bytes: no clock, no locale, no
// randomness, no stored state. Identical bytes always yield identical ids.
// ---------------------------------------------------------------------------

// A non-markdown segment holds at most this many lines.
const SEGMENT_WINDOW_LINES = 60;
// A window boundary may move backwards at most this far to land on a blank
// line. Backwards only: moving forwards would break the "at most 60" promise.
const SEGMENT_SNAP_RADIUS = 10;
const MARKDOWN_EXTENSIONS = [".md", ".markdown"];
// Content before a markdown file's first heading is its own segment. The slug
// rule below can never produce a leading underscore, so this id cannot collide
// with a heading slug.
const PREAMBLE_SLUG = "_preamble";

function isMarkdownPath(path) {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Lines are 1-indexed everywhere in segment ids. A single trailing newline is
// the line terminator of the last line, not the start of an empty one, so it is
// dropped before splitting; an empty file therefore has zero lines and zero
// segments.
function splitLines(content) {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

// GitHub-shaped, but spelled out here so it never depends on a library or on a
// locale: lowercase (String#toLowerCase is locale-independent; toLocaleLowerCase
// is not), every run of characters that is neither a Unicode letter nor a
// Unicode digit collapses to a single "-", and leading/trailing "-" are dropped.
// Letters and digits are kept rather than restricted to ASCII so a CJK heading
// keeps its identity instead of collapsing to a bare fallback.
function headingSlug(text) {
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "section";
}

// Markdown splits at ATX heading boundaries. Headings inside fenced code blocks
// are text, not structure, so fences are tracked and their contents ignored.
function markdownSegments(path, lines) {
  if (lines.length === 0) return [];
  const boundaries = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/u.exec(line);
    if (heading) boundaries.push({ line: index, text: heading[1].replace(/\s+#+\s*$/u, "").trim() });
  }
  const segments = [];
  const firstHeading = boundaries.length > 0 ? boundaries[0].line : lines.length;
  if (firstHeading > 0) {
    segments.push({ id: `${path}#${PREAMBLE_SLUG}`, slug: PREAMBLE_SLUG, heading: null, start: 1, end: firstHeading });
  }
  // Two headings can slug identically. Disambiguation is positional and
  // deterministic: the first occurrence keeps the bare slug, the nth gets
  // "-<n>" appended, in file order.
  const seen = new Map();
  boundaries.forEach((boundary, index) => {
    const base = headingSlug(boundary.text);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const slug = count === 1 ? base : `${base}-${count}`;
    const end = index + 1 < boundaries.length ? boundaries[index + 1].line : lines.length;
    segments.push({ id: `${path}#${slug}`, slug, heading: boundary.text, start: boundary.line + 1, end });
  });
  return segments;
}

// Everything that is not markdown splits into line windows. The nominal end of
// a window is start + 59. If that is not already the last line of the file, the
// boundary is searched backwards from the nominal end, one line at a time, for
// up to SEGMENT_SNAP_RADIUS lines, and moves to the first blank (whitespace-only)
// line found; the blank line becomes the last line of the segment. If no blank
// line is within reach, or the search would run past the start of the window,
// the hard nominal boundary stands. The next window starts on the following
// line, so segments always cover every line with no gap and no overlap.
function windowSegments(path, lines) {
  const segments = [];
  let start = 0;
  while (start < lines.length) {
    const nominal = start + SEGMENT_WINDOW_LINES - 1;
    let end;
    if (nominal >= lines.length - 1) {
      end = lines.length - 1;
    } else {
      end = nominal;
      for (let distance = 0; distance <= SEGMENT_SNAP_RADIUS; distance += 1) {
        const candidate = nominal - distance;
        if (candidate < start) break;
        if (lines[candidate].trim() === "") {
          end = candidate;
          break;
        }
      }
    }
    segments.push({ id: `${path}#L${start + 1}-${end + 1}`, start: start + 1, end: end + 1 });
    start = end + 1;
  }
  return segments;
}

function segmentFile(path, content) {
  const lines = splitLines(content);
  return isMarkdownPath(path) ? markdownSegments(path, lines) : windowSegments(path, lines);
}

function repoRelativePath(repo, value) {
  const root = resolve(repo);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  if (absolute === root || !absolute.startsWith(`${root}${sep}`)) {
    throw new VibeHubError("invalid_argument", `--path must name a file inside the repository: ${value}`);
  }
  return absolute.slice(root.length + 1).split(sep).join("/");
}

// A NUL byte in the first bytes of a file is the standard cheap binary signal.
// Segmenting a binary blob into "lines" would be noise, not coverage.
function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function sourceOperation(operation, repo, options = {}) {
  if (operation !== "segment") {
    throw new VibeHubError("unsupported_operation", `Unsupported source operation: ${operation}`);
  }
  if (typeof options.path !== "string" || !options.path.trim()) {
    throw new VibeHubError("invalid_argument", "source segment needs --path <file> relative to the repository root");
  }
  const relative = repoRelativePath(repo, options.path);
  const absolute = join(repo, relative);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new VibeHubError("not_found", `File not found: ${relative}`);
  }
  const buffer = readFileSync(absolute);
  if (isBinary(buffer)) {
    throw new VibeHubError("invalid_input", `Refusing to segment a binary file: ${relative}`);
  }
  const content = buffer.toString("utf8");
  const segments = segmentFile(relative, content);
  return {
    path: relative,
    strategy: isMarkdownPath(relative) ? "markdown-headings" : "line-windows",
    lines: splitLines(content).length,
    segment_count: segments.length,
    segments,
  };
}

// ---------------------------------------------------------------------------
// Coverage.
//
// Everything here is derived from the working tree on every invocation: the
// anchored files are walked, segmented, and matched against the Contexts that
// are on disk right now. Nothing is cached and nothing is written.
// ---------------------------------------------------------------------------

function walkSourceFiles(repo, relative, out) {
  const entries = readdirSync(join(repo, relative), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    // .git is machinery, never source. Symlinks are neither isFile nor
    // isDirectory here, so they are skipped and cannot escape the anchor.
    if (entry.name === ".git") continue;
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) walkSourceFiles(repo, child, out);
    else if (entry.isFile()) out.push(child);
  }
}

function anchoredSourceFiles(repo, document) {
  const files = [];
  for (const anchor of document.anchors ?? []) {
    if (typeof anchor !== "string") continue;
    const relative = anchor.replace(/\/+$/u, "");
    if (!relative || relative.split("/").includes("..")) continue;
    const absolute = join(repo, relative);
    if (!existsSync(absolute)) continue;
    const stats = lstatSync(absolute);
    if (stats.isFile()) files.push(relative);
    else if (stats.isDirectory()) walkSourceFiles(repo, relative, files);
  }
  return [...new Set(files)].sort();
}

// Citations are collected repository-wide, not per room: a Context filed in one
// room can legitimately cite a segment of a file anchored by another.
function citationRefs(repository) {
  const refs = new Set();
  for (const { document } of repository.contexts.documents.values()) {
    const sourceRef = document?.source?.ref;
    if (typeof sourceRef === "string" && sourceRef.trim()) refs.add(sourceRef.trim());
    for (const item of document?.evidence ?? []) {
      if (typeof item?.ref === "string" && item.ref.trim()) refs.add(item.ref.trim());
    }
  }
  return refs;
}

// A ref matches a segment when it equals the segment id. A bare file path with
// no "#" fragment covers every segment of that file: citing a source without
// narrowing to a segment is a claim about the whole of it, and treating it
// otherwise would make coverage unreachable for anything cited as a document.
function refCovers(refs, segmentId, filePath) {
  return refs.has(segmentId) || refs.has(filePath);
}

function contextCoverage(repo, repository, roomFilter = null) {
  if (roomFilter !== null && !repository.rooms.documents.has(roomFilter)) {
    throw new VibeHubError("not_found", `Room not found: ${roomFilter}`);
  }
  const refs = citationRefs(repository);
  const rooms = [];
  let uncoveredTotal = 0;
  let segmentsTotal = 0;
  let filesExamined = 0;
  const entries = [...repository.rooms.documents.entries()]
    .filter(([roomPath]) => roomFilter === null || roomPath === roomFilter)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [roomPath, { document }] of entries) {
    const exceptions = new Set(
      (document.coverage_exceptions ?? [])
        .map((item) => item?.segment)
        .filter((segment) => typeof segment === "string"),
    );
    const files = [];
    let roomUncovered = 0;
    for (const filePath of anchoredSourceFiles(repo, document)) {
      const buffer = readFileSync(join(repo, filePath));
      if (isBinary(buffer)) {
        files.push({ path: filePath, skipped: "binary", segment_count: 0, uncovered: [] });
        continue;
      }
      const segments = segmentFile(filePath, buffer.toString("utf8"));
      filesExamined += 1;
      segmentsTotal += segments.length;
      const uncovered = segments
        .filter((segment) => !refCovers(refs, segment.id, filePath)
          && !refCovers(exceptions, segment.id, filePath))
        .map((segment) => segment.id);
      roomUncovered += uncovered.length;
      files.push({ path: filePath, skipped: null, segment_count: segments.length, uncovered });
    }
    uncoveredTotal += roomUncovered;
    rooms.push({ room: roomPath, files, uncovered: roomUncovered });
  }
  return {
    rooms,
    files_examined: filesExamined,
    segments_total: segmentsTotal,
    uncovered_total: uncoveredTotal,
  };
}

// ---------------------------------------------------------------------------
// Skill graph.
//
// Development-time validation only. `skills validate` reads the checked-in
// skills tree and `skills/vibehub-core/contracts/skill-graph.json` from the
// repository under --repo, compares them, and writes nothing. No Skill reads
// the contract at runtime and nothing here touches .vibehub/: this is a check
// a developer runs before changing a Skill, not a router or a lifecycle.
// ---------------------------------------------------------------------------

const SKILL_DIR_PREFIX = "vibehub-";
const SKILL_REFERENCE = /\$(vibehub-[a-z0-9]+(?:-[a-z0-9]+)*)/gu;
const SKILL_EDGE_KINDS = ["invokes", "presents", "routes"];
const SKILL_ENTRY_KINDS = new Set(["user", "internal", "infrastructure"]);
const SKILL_GRAPH_CONTRACT = "skills/vibehub-core/contracts/skill-graph.json";
// Gitignored build and dependency output. A stale dist/ copied before a rename
// is not a live reference to fix; it is regenerated by `npm run build`.
const SKILL_SCAN_SKIP = new Set([".git", "node_modules", "dist", "coverage", "test-results"]);

function skillDirectories(repo) {
  const skillsPath = join(repo, "skills");
  if (!existsSync(skillsPath) || !lstatSync(skillsPath).isDirectory()) {
    throw new VibeHubError("not_found", "No skills/ directory under the repository root");
  }
  return readdirSync(skillsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SKILL_DIR_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

// Walks files under a repository-relative directory.
//
// A symlink is never followed — that is what keeps the walk inside the root —
// but it is not skipped either. Git checks a symlink in as a blob holding its
// TARGET PATH, so that path string is the file's checked-in content and is
// scanned like any other text. A link named `docs/app.js` pointing at
// `../skills/<retired>/assets/app.js` used to be invisible to this walk.
//
// A file whose first 8000 bytes hold a NUL is classified binary. It is still
// scanned, decoded as latin1, because a single NUL appended to a Markdown file
// used to hide every reference in it. Binary files are marked so callers that
// care about source structure (Skill references) can drop them; the retired
// name check reads them.
function walkTextFiles(repo, relative, out) {
  const absolute = join(repo, relative);
  if (!existsSync(absolute)) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKILL_SCAN_SKIP.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      out.push({ path: child, text: readlinkSync(join(repo, child)), symlink: true });
      continue;
    }
    // A nested checkout or worktree (anything carrying its own .git) is a
    // different repository's source, not this one's.
    if (entry.isDirectory()) {
      if (existsSync(join(repo, child, ".git"))) continue;
      walkTextFiles(repo, child, out);
    }
    else if (entry.isFile()) {
      const buffer = readFileSync(join(repo, child));
      const binary = isBinary(buffer);
      out.push({ path: child, text: buffer.toString(binary ? "latin1" : "utf8"), binary });
    }
  }
}

function countOccurrences(text, needle) {
  if (needle === "") return 0;
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

// A Skill's references are collected from every text file it ships, not from
// SKILL.md alone: bulk absorption's process reference and the host agent
// prompts carry real $-invocations too, and a reference the contract does not
// explain is exactly what this check exists to catch.
function skillReferences(repo, names) {
  const references = new Map(names.map((name) => [name, new Map()]));
  for (const name of names) {
    const files = [];
    walkTextFiles(repo, `skills/${name}`, files);
    for (const file of files) {
      if (file.binary) continue;
      for (const match of file.text.matchAll(SKILL_REFERENCE)) {
        const target = match[1];
        if (target === name) continue;
        if (!references.get(name).has(target)) references.get(name).set(target, file.path);
      }
    }
  }
  return references;
}

function findSkillCycle(adjacency) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(name) {
    if (visiting.has(name)) return [...stack.slice(stack.indexOf(name)), name];
    if (visited.has(name)) return null;
    visiting.add(name);
    stack.push(name);
    for (const target of adjacency.get(name) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(name);
    visited.add(name);
    return null;
  }
  for (const name of [...adjacency.keys()].sort()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

// Positional JSON parser.
//
// Every legitimate-field exemption below has to answer the same question: which
// RAW BYTES of the checked-in file does this parsed value occupy? Re-serialising
// the parse and scanning that answered a different question, and the difference
// is a hole: any bytes JSON.parse discards — a shadowed duplicate key, the
// original escaping, whitespace — never reached the scan at all, so a live
// `../<retired>/...` path hidden under a duplicate key passed while sitting in
// the file in plain ASCII. The scan reads the raw text; the parse only says
// which SPANS of that raw text to consume first.
//
// The tree mirrors JSON.parse's own semantics so the spans describe the same
// document: an object member is stored by key with the LAST duplicate winning,
// which is exactly what makes a shadowed earlier duplicate's span survive into
// the scan. Trailing content after the top-level value is a parse failure, as
// it is for JSON.parse.
const JSON_SIMPLE_ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

function parseJsonWithSpans(text) {
  let at = 0;
  const fail = (message) => {
    throw new SyntaxError(`${message} at offset ${at}`);
  };
  const skipSpace = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\t" || text[at] === "\n" || text[at] === "\r")) at += 1;
  };
  function parseString() {
    const start = at;
    if (text[at] !== '"') fail("expected a string");
    at += 1;
    let value = "";
    for (;;) {
      if (at >= text.length) fail("unterminated string");
      const ch = text[at];
      if (ch === '"') {
        at += 1;
        break;
      }
      if (ch === "\\") {
        const escape = text[at + 1];
        at += 2;
        if (escape === "u") {
          const hex = text.slice(at, at + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("malformed \\u escape");
          value += String.fromCharCode(Number.parseInt(hex, 16));
          at += 4;
          continue;
        }
        const simple = JSON_SIMPLE_ESCAPES[escape];
        if (simple === undefined) fail("unknown escape");
        value += simple;
        continue;
      }
      if (ch < " ") fail("control character in a string");
      value += ch;
      at += 1;
    }
    return { type: "string", value, start, end: at };
  }
  function parseValue() {
    skipSpace();
    if (at >= text.length) fail("unexpected end of input");
    const ch = text[at];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, at)) {
        at += literal.length;
        return { type: "literal", value };
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(at));
    if (!number) fail("unexpected token");
    at += number[0].length;
    return { type: "literal", value: Number(number[0]) };
  }
  function parseObject() {
    at += 1;
    const members = new Map();
    skipSpace();
    if (text[at] === "}") {
      at += 1;
      return { type: "object", members };
    }
    for (;;) {
      skipSpace();
      const key = parseString();
      skipSpace();
      if (text[at] !== ":") fail("expected :");
      at += 1;
      // Last duplicate wins, as in JSON.parse. The earlier member's span is
      // dropped here on purpose: those bytes are shadowed, so nothing excuses
      // them and the scan must still see them.
      members.set(key.value, parseValue());
      skipSpace();
      if (text[at] === ",") {
        at += 1;
        continue;
      }
      if (text[at] === "}") {
        at += 1;
        return { type: "object", members };
      }
      fail("expected , or }");
    }
  }
  function parseArray() {
    at += 1;
    const items = [];
    skipSpace();
    if (text[at] === "]") {
      at += 1;
      return { type: "array", items };
    }
    for (;;) {
      items.push(parseValue());
      skipSpace();
      if (text[at] === ",") {
        at += 1;
        continue;
      }
      if (text[at] === "]") {
        at += 1;
        return { type: "array", items };
      }
      fail("expected , or ]");
    }
  }
  const root = parseValue();
  skipSpace();
  if (at !== text.length) fail("trailing content after the top-level value");
  return root;
}

function nodeValue(node) {
  if (node.type === "object") {
    // A null prototype, so a `__proto__` member becomes an OWN property exactly
    // as JSON.parse makes it. On a plain object literal the assignment would hit
    // the prototype setter instead, the key would vanish from the comparison,
    // and a document carrying `__proto__` would be reported as a parser
    // disagreement it is not.
    const out = Object.create(null);
    for (const [key, child] of node.members) out[key] = nodeValue(child);
    return out;
  }
  if (node.type === "array") return node.items.map(nodeValue);
  return node.value;
}

function objectMember(node, key) {
  return node && node.type === "object" ? node.members.get(key) : undefined;
}

function arrayItems(node) {
  return node && node.type === "array" ? node.items : [];
}

// Replaces each span's CONTENTS with nothing, keeping the surrounding quotes so
// the bytes on either side can never be joined into a name that was not there.
// Spans are removed right to left so earlier offsets stay valid.
function blankSpans(text, spans) {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start + 1) + out.slice(span.end - 1);
  }
  return out;
}

// The bridge between "which values are legitimate" and "which raw bytes to
// consume". The positional parser must agree with JSON.parse about the
// document, or the spans describe a file other than the one being scanned; a
// disagreement is reported LOUDLY and nothing is consumed, so the raw text is
// scanned whole. Failing closed and silent would let a parser quirk become the
// next bypass, and failing open and quiet would let one land unnoticed.
function legitimateSpans(text, select) {
  let expected;
  try {
    expected = JSON.parse(text);
  } catch {
    return { skip: true };
  }
  let root;
  try {
    root = parseJsonWithSpans(text);
  } catch (error) {
    return { problem: `could not be located in the raw file (${error.message})` };
  }
  if (JSON.stringify(nodeValue(root)) !== JSON.stringify(expected)) {
    return { problem: "the positional parse disagrees with JSON.parse about this document" };
  }
  return { document: expected, spans: select(root, expected) };
}

// A Context document's `source.ref` and `evidence[].ref` record what proved a
// past claim, so those two field values are exempt — their RAW SPANS are
// consumed out of the checked-in text and everything else in the file, prose
// included, is scanned as bytes.
//
// Consuming the raw span rather than subtracting an occurrence count is what
// makes this exact, and consuming it out of the RAW text rather than out of a
// re-serialisation is what keeps it honest. A count subtracted from the whole
// file could be spent on an occurrence somewhere else in it: a ref written with
// a JSON escape (`vibehub-ticket-\u0072eview`) parses to the retired name while
// the raw bytes never spell it, so the subtraction landed on a live prose
// mention instead. Consuming the span removes the escaped bytes themselves and
// leaves the prose mention to fail. And because the scan reads the raw file, a
// live path carried by a shadowed duplicate key — bytes JSON.parse drops — is
// no longer invisible.
//
// The exemption belongs to Context, not to the two field names. It is claimed
// only by a document that is one: a `kind: context` document under
// .vibehub/rooms/. Otherwise any live JSON anywhere in the tree could carry a
// retired path under a `source.ref` key and buy itself silence.
function contextSpans(path, text) {
  if (!path.startsWith(".vibehub/rooms/")) return null;
  const located = legitimateSpans(text, (root) => {
    const spans = [];
    const source = objectMember(root, "source");
    const ref = objectMember(source, "ref");
    if (ref && ref.type === "string") spans.push(ref);
    for (const entry of arrayItems(objectMember(root, "evidence"))) {
      const entryRef = objectMember(entry, "ref");
      if (entryRef && entryRef.type === "string") spans.push(entryRef);
    }
    return spans;
  });
  // Not JSON at all, or not a Context document: no exemption, and no complaint
  // either. A .vibehub/rooms/ file that is not a Context document is simply
  // scanned like every other file in the tree.
  if (located.skip) return null;
  if (located.problem) return located;
  if (!isObject(located.document) || located.document.kind !== "context") return null;
  return located;
}

// Historical records, which name a retired Skill because that is what was true
// when they were written. Detected structurally, never by allowlist:
//   - .vibehub/evidence/, .vibehub/outcomes/, and the .vibehub/history/ archive
//   - a Ticket under .vibehub/tickets/ whose Outcome is SUCCESSFUL
//   - a META/legacy-* tree, matched only as the segment directly under META/
//
// A Ticket is a historical record only once its Outcome says `successful`. A
// partial, failed or deviated Outcome means the work is still live — the
// Ticket's own next_action is REPLAN — so its YAML is a live document whose
// references still have to be right. This is deliberately STRICTER than the
// notion of "closed" loadRepository uses for lifecycle-scoped context_refs,
// which counts a Ticket as closed the moment any Outcome exists. The two are
// answering different questions: a context ref is pinned to the commit that
// closed the loop, whereas a retired name in a still-live Ticket is a reference
// someone will read and copy tomorrow. The divergence is scoped to this check
// on purpose; unifying it would change an accepted, closed behaviour.
// Every one of these is a whole directory whose contents are archived by
// construction. A file's own name never earns an exemption: a dated basename
// under META/ used to imply "record", which meant anyone could date-prefix a
// live spec to silence the rule. A genuine dated record is exempted by an
// explicit allowlist entry naming the text it carries, like any other file.
// Everything else under META/ stays live, which is the point: an active META
// spec naming skills/<retired>/SKILL.md is precisely the reference that slipped
// past a careful human grep during the rename it documents.
function isHistoricalRecord(repo, path) {
  if (path.startsWith(".vibehub/evidence/")) return true;
  if (path.startsWith(".vibehub/outcomes/")) return true;
  if (path.startsWith(".vibehub/history/")) return true;
  if (path.startsWith(".vibehub/tickets/") && path.endsWith(".yaml")) {
    const id = path.slice(".vibehub/tickets/".length, -".yaml".length);
    const outcomePath = join(repo, ".vibehub", "outcomes", `${id}.yaml`);
    if (!existsSync(outcomePath)) return false;
    let outcome;
    try {
      outcome = readDocument(outcomePath);
    } catch {
      return false;
    }
    return isObject(outcome) && outcome.status === "successful";
  }
  if (path.startsWith("META/")) {
    const segments = path.split("/");
    // Leading segment only: META/legacy-ui/note.md is archived, but
    // META/09-ticket-runtime/legacy-notes/live.md is a live spec in a
    // conveniently named folder.
    if (segments.length > 2 && segments[1].startsWith("legacy-")) return true;
  }
  return false;
}

// One exempt class is not machine-detectable: an occurrence a human decided to
// keep — prose describing the retirement, a documented legacy-path constant
// kept so historical commits stay readable, a dated record under META/. Intent
// is not in the bytes, so the contract pins those occurrences one by one.
//
// An allowance excuses OCCURRENCES, never a file. It names the path, the exact
// `text` it excuses, how many times that text occurs (`occurrences`, default 1),
// and why. Any occurrence of the retired name in that file which no allowance's
// text accounts for still fails, so appending a live reference to an allowlisted
// file is caught. The counts are what make it per-occurrence rather than
// per-line: duplicating an excused line changes the count and fails.
//
// Four shape rules keep an allowance from degenerating back into a file pass:
// its text must contain the retired name (otherwise it excuses nothing), must
// be strictly NARROWER than the name (a text that is just the bare name excuses
// any occurrence in the file, including a live path swapped in later — the
// count stays at one and the file passes), must be a single line (otherwise
// "text" could be the whole file), and must occur exactly as many times as
// declared. A stale allowance — file gone, text gone, or count moved — is
// itself a failure, so the list cannot rot into a silent blanket exemption. A
// `$`-invocation is a live call wherever it appears and fails inside an
// allowlisted file too, unless an allowance names that exact `$`-carrying text
// and says why.
//
// Excusing works by DELETING each allowance's spans from the text and then
// scanning what remains, not by subtracting counts. Counting let two
// allowances whose texts overlap the same occurrence subtract two, buying the
// file one silent live reference elsewhere; a deleted span can only be
// consumed once.
function stripAll(text, needle) {
  return text.split(needle).join("");
}

function countOccurrencesInsensitive(text, needle) {
  return countOccurrences(text.toLowerCase(), needle.toLowerCase());
}

// Removes up to `declared` occurrences of each allowance's text, longest text
// first so a short allowance cannot eat the span a longer one names.
function consumeAllowances(text, allowances) {
  let residual = text;
  for (const allowance of [...allowances].sort((a, b) => b.text.length - a.text.length)) {
    for (let taken = 0; taken < allowance.declared; taken += 1) {
      const at = residual.indexOf(allowance.text);
      if (at === -1) break;
      residual = residual.slice(0, at) + residual.slice(at + allowance.text.length);
    }
  }
  return residual;
}

// The contract is scanned like every other file, and now as its own RAW BYTES.
// It is not exempt by path — that is exactly the per-file exemption this rule
// outlaws, and it used to let any stray key in the contract carry a live
// `../<retired>/...` path.
//
// What the contract legitimately holds is three PARSED FIELDS: each retired
// entry's `name` and `replacement`, and each allowance's `text`. Those values
// are exempt by consuming THEIR RAW SPANS out of the checked-in file, so
// anything else in the document — a stray key, a `reason` that quotes a live
// path, an allowance `path` under the retired folder, or a value shadowed by a
// duplicate key and therefore absent from the parse — is scanned normally and
// fails.
function contractSpans(text) {
  const located = legitimateSpans(text, (root) => {
    const spans = [];
    for (const entry of arrayItems(objectMember(root, "retired"))) {
      for (const key of ["name", "replacement"]) {
        const field = objectMember(entry, key);
        if (field && field.type === "string") spans.push(field);
      }
      for (const allowance of arrayItems(objectMember(entry, "allowed_paths"))) {
        const field = objectMember(allowance, "text");
        if (field && field.type === "string") spans.push(field);
      }
    }
    return spans;
  });
  // validateSkillGraph has already parsed the contract through readDocument, so
  // a parse failure here means the bytes on disk are not the document the rest
  // of the check ran against. Report it rather than silently exempting nothing.
  if (located.skip) return { problem: "is not parseable as JSON, so its legitimate fields cannot be located" };
  return located;
}

// Applies the legitimate-field exemptions to the raw text of one file.
//
// A located problem is a LOUD failure that consumes nothing: the file's raw
// bytes are still scanned in full, so a file whose spans cannot be located can
// only ever be reported as MORE suspicious, never less. The alternative —
// skipping the file, or silently consuming nothing without saying so — is how a
// parser disagreement becomes the next quiet bypass.
function applyLegitimateSpans(file, errors) {
  const located = file.path === SKILL_GRAPH_CONTRACT ? contractSpans(file.text) : contextSpans(file.path, file.text);
  if (located === null) return file;
  if (located.problem) {
    add(errors, file.path, `Legitimate-field exemption not applied: the document ${located.problem}; the whole file is scanned`);
    return file;
  }
  return { ...file, text: blankSpans(file.text, located.spans) };
}

function validateRetiredNames(repo, contract, allFiles, errors) {
  const files = allFiles.map((file) => applyLegitimateSpans(file, errors));
  const texts = new Map(files.map((file) => [file.path, file.text]));
  for (const [index, entry] of (Array.isArray(contract.retired) ? contract.retired : []).entries()) {
    const path = `retired[${index}]`;
    if (!isObject(entry) || typeof entry.name !== "string" || typeof entry.replacement !== "string"
      || entry.name === "" || entry.replacement === "") {
      add(errors, path, "A retired entry needs a non-empty name and its replacement");
      continue;
    }
    const allowances = [];
    for (const [allowIndex, allowance] of (Array.isArray(entry.allowed_paths) ? entry.allowed_paths : []).entries()) {
      const where = `${path}.allowed_paths[${allowIndex}]`;
      if (!isObject(allowance) || typeof allowance.path !== "string" || typeof allowance.text !== "string"
        || typeof allowance.reason !== "string") {
        add(errors, where, "An allowance needs a path, the exact text it excuses, and a reason");
        continue;
      }
      if (countOccurrencesInsensitive(allowance.text, entry.name) === 0) {
        add(errors, where, `The excused text does not contain ${entry.name}, so it excuses nothing`);
        continue;
      }
      // Narrower than the bare name: strip every occurrence of the name and
      // something meaningful must remain. A text that is the bare name on its
      // own, or padded with whitespace, or repeated, would match any occurrence
      // in the file and turn the allowance back into a count-bounded file pass.
      if (stripAll(allowance.text.toLowerCase(), entry.name.toLowerCase()).trim() === "") {
        add(
          errors,
          where,
          `The excused text is no narrower than ${entry.name} itself; name the surrounding line so the allowance points at one occurrence`,
        );
        continue;
      }
      if (/[\n\r]/u.test(allowance.text)) {
        add(errors, where, "The excused text must be a single line, naming one occurrence rather than a span");
        continue;
      }
      const declared = allowance.occurrences ?? 1;
      if (!Number.isInteger(declared) || declared < 1) {
        add(errors, where, "occurrences must be a positive integer");
        continue;
      }
      allowances.push({ where, path: allowance.path, text: allowance.text, declared });
    }

    // Stale allowances first: a count that no longer matches is a failure in its
    // own right, and the excusing below is capped at what the file really holds.
    for (const allowance of allowances) {
      const text = texts.get(allowance.path);
      if (text === undefined) {
        add(errors, `${path}.allowed_paths`, `${allowance.path} no longer contains ${entry.name}; drop the allowance`);
        continue;
      }
      const actual = countOccurrences(text, allowance.text);
      if (actual === 0) {
        add(
          errors,
          `${path}.allowed_paths`,
          `${allowance.path} no longer contains the excused text ${JSON.stringify(allowance.text)}; drop or update the allowance`,
        );
      } else if (actual !== allowance.declared) {
        add(
          errors,
          `${path}.allowed_paths`,
          `${allowance.path} carries ${actual} occurrence${actual === 1 ? "" : "s"} of ${JSON.stringify(allowance.text)} but the allowance names ${allowance.declared}`,
        );
      }
    }

    const byPath = new Map();
    for (const allowance of allowances) {
      if (!byPath.has(allowance.path)) byPath.set(allowance.path, []);
      byPath.get(allowance.path).push(allowance);
    }

    for (const file of files) {
      if (countOccurrencesInsensitive(file.text, entry.name) === 0) continue;
      if (isHistoricalRecord(repo, file.path)) continue;

      const residual = consumeAllowances(file.text, byPath.get(file.path) ?? []);

      if (countOccurrences(residual, `$${entry.name}`) > 0) {
        add(errors, file.path, `Retired Skill ${entry.name} is invoked as $${entry.name}; use $${entry.replacement}`);
        continue;
      }
      const live = countOccurrences(residual, entry.name);
      if (live > 0) {
        add(
          errors,
          file.path,
          `Live reference to retired Skill ${entry.name} (${live} unexcused occurrence${live === 1 ? "" : "s"}); use ${entry.replacement}, or name the exact occurrence and its reason in ${SKILL_GRAPH_CONTRACT}`,
        );
        continue;
      }
      // A case-varied path is the same retired folder on a case-insensitive
      // filesystem and the same name to a reader, so it cannot pass by
      // spelling alone.
      const variants = countOccurrencesInsensitive(residual, entry.name) - countOccurrences(residual, entry.name);
      if (variants > 0) {
        add(
          errors,
          file.path,
          `Case-variant reference to retired Skill ${entry.name} (${variants} unexcused occurrence${variants === 1 ? "" : "s"}); use ${entry.replacement}`,
        );
      }
    }
  }
}

function validateSkillGraph(repo) {
  const errors = [];
  const contractPath = join(repo, SKILL_GRAPH_CONTRACT);
  if (!existsSync(contractPath)) {
    throw new VibeHubError("not_found", `Skill graph contract not found: ${SKILL_GRAPH_CONTRACT}`);
  }
  const contract = readDocument(contractPath);
  if (!isObject(contract) || !Array.isArray(contract.skills)) {
    throw new VibeHubError("invalid_input", `${SKILL_GRAPH_CONTRACT} needs a skills array`);
  }

  const present = skillDirectories(repo);
  const declared = new Map();
  for (const [index, entry] of contract.skills.entries()) {
    const path = `skills[${index}]`;
    if (!isObject(entry) || typeof entry.name !== "string") {
      add(errors, path, "A declared Skill needs a name");
      continue;
    }
    if (declared.has(entry.name)) add(errors, path, `Duplicate declaration of ${entry.name}`);
    if (!SKILL_ENTRY_KINDS.has(entry.entry)) {
      add(errors, `${path}.entry`, `entry must be one of ${[...SKILL_ENTRY_KINDS].join(", ")}`);
    }
    for (const kind of SKILL_EDGE_KINDS) {
      if (!Array.isArray(entry[kind])) add(errors, `${path}.${kind}`, `${kind} must be an array`);
    }
    if (!Array.isArray(entry.events)) add(errors, `${path}.events`, "events must be an array");
    declared.set(entry.name, entry);
  }
  assertValid(errors, "Skill graph validation failed");

  for (const name of present) {
    if (!declared.has(name)) {
      add(errors, `skills/${name}`, `Skill is present in skills/ but missing from ${SKILL_GRAPH_CONTRACT}`);
    }
  }
  for (const name of declared.keys()) {
    if (!present.includes(name)) {
      add(errors, `skills[${name}]`, "Declared Skill has no folder under skills/");
    }
  }
  assertValid(errors, "Skill graph validation failed");

  const outbound = new Map(present.map((name) => [name, new Set()]));
  const inbound = new Map(present.map((name) => [name, new Set()]));
  const invokes = new Map(present.map((name) => [name, []]));
  for (const name of present) {
    const entry = declared.get(name);
    for (const kind of SKILL_EDGE_KINDS) {
      for (const target of entry[kind]) {
        const path = `skills[${name}].${kind}`;
        if (typeof target !== "string" || !declared.has(target)) {
          add(errors, path, `Edge target ${JSON.stringify(target)} is not a declared Skill`);
          continue;
        }
        if (target === name) {
          add(errors, path, "A Skill cannot declare an edge to itself");
          continue;
        }
        if (declared.get(target).entry === "infrastructure") {
          add(errors, path, `${target} is infrastructure and is never invoked`);
          continue;
        }
        outbound.get(name).add(target);
        inbound.get(target).add(name);
        if (kind === "invokes") invokes.get(name).push(target);
      }
    }
    if (entry.entry === "infrastructure" && SKILL_EDGE_KINDS.some((kind) => entry[kind].length > 0)) {
      add(errors, `skills[${name}]`, "An infrastructure Skill holds no edges");
    }
  }
  assertValid(errors, "Skill graph validation failed");

  // A reference is direction-blind on purpose. `vibehub-distill` documents its
  // own callers in its description ("Invoked by ..."), so requiring the mention
  // to sit in the caller's folder would reject a true edge. A reference is
  // explained when the contract declares an edge incident to both Skills.
  const references = skillReferences(repo, present);
  for (const name of present) {
    for (const [target, where] of references.get(name)) {
      if (!present.includes(target)) {
        add(errors, where, `$${target} names a Skill that does not exist under skills/`);
        continue;
      }
      if (!outbound.get(name).has(target) && !outbound.get(target).has(name)) {
        add(errors, where, `$${target} is referenced by ${name} but no edge between them is declared in ${SKILL_GRAPH_CONTRACT}`);
      }
    }
  }

  for (const name of present) {
    for (const target of outbound.get(name)) {
      if (references.get(name).has(target) || references.get(target).has(name)) continue;
      add(
        errors,
        `skills[${name}]`,
        `Declared edge ${name} -> ${target} appears in no SKILL.md or Skill reference; no $${target} in skills/${name}/ and no $${name} in skills/${target}/`,
      );
    }
  }

  for (const name of present) {
    const entry = declared.get(name);
    if (entry.entry !== "internal") continue;
    if (inbound.get(name).size === 0) {
      add(errors, `skills[${name}]`, "Internal Skill is an orphan: no user entry and no inbound edge");
    }
  }

  const cycle = findSkillCycle(invokes);
  if (cycle) add(errors, "skills", `Invocation cycle: ${cycle.join(" -> ")}`);

  const owners = new Map();
  for (const name of present) {
    for (const event of declared.get(name).events) {
      if (typeof event !== "string") {
        add(errors, `skills[${name}].events`, "An owned event must be a string");
        continue;
      }
      if (owners.has(event)) add(errors, `skills[${name}].events`, `${event} is already owned by ${owners.get(event)}`);
      else owners.set(event, name);
    }
  }
  if (typeof contract.lifecycle_contract === "string") {
    const lifecyclePath = join(repo, "skills", contract.lifecycle_contract);
    if (!existsSync(lifecyclePath)) {
      add(errors, "lifecycle_contract", `${contract.lifecycle_contract} not found under skills/`);
    } else {
      const lifecycle = readDocument(lifecyclePath);
      for (const event of Array.isArray(lifecycle.events) ? lifecycle.events : []) {
        if (!isObject(event) || typeof event.event !== "string") continue;
        if (!owners.has(event.event)) {
          add(errors, "lifecycle_contract", `${event.event} is owned by ${event.owner} in the lifecycle but declared by no Skill`);
        } else if (owners.get(event.event) !== event.owner) {
          add(
            errors,
            "lifecycle_contract",
            `${event.event} is owned by ${owners.get(event.event)} in the graph and by ${event.owner} in the lifecycle`,
          );
        }
      }
      for (const [event, owner] of owners) {
        const known = (lifecycle.events ?? []).some((candidate) => isObject(candidate) && candidate.event === event);
        if (!known) add(errors, `skills[${owner}].events`, `${event} is not an event in ${contract.lifecycle_contract}`);
      }
    }
  }

  const files = [];
  walkTextFiles(repo, "", files);
  validateRetiredNames(repo, contract, files, errors);

  assertValid(errors, "Skill graph validation failed");
  const edgeCount = present.reduce((total, name) => total + outbound.get(name).size, 0);
  return {
    valid: true,
    skills: present.length,
    edges: edgeCount,
    entry_points: present.filter((name) => declared.get(name).entry === "user"),
    internal: present.filter((name) => declared.get(name).entry === "internal"),
    infrastructure: present.filter((name) => declared.get(name).entry === "infrastructure"),
    events: owners.size,
    retired: (contract.retired ?? []).map((entry) => ({ name: entry.name, replacement: entry.replacement })),
    files_scanned: files.length,
  };
}

function skillsOperation(operation, repo) {
  if (operation === "validate") return validateSkillGraph(repo);
  throw new VibeHubError("unsupported_operation", `Unsupported skills operation: ${operation}`);
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
      unverifiable_context_refs: repository.unverifiable,
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
  else if (args.domain === "ticket") data = ticketOperation(args.operation, args.repo, input, {
    scope: args.scope,
    delivery: args.delivery,
    rooms: args.rooms,
  });
  else if (args.domain === "project") data = projectOperation(args.operation, args.repo, input);
  else if (args.domain === "source") data = sourceOperation(args.operation, args.repo, { path: args.path });
  else if (args.domain === "skills") data = skillsOperation(args.operation, args.repo);
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
