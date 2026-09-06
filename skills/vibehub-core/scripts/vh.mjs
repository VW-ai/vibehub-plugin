#!/usr/bin/env node
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVISION_BINDING_ORIGINS,
  REVISION_BINDING_STATES,
  REVISION_IDENTITY,
  acceptanceIdentity,
  acceptanceReference,
  acceptanceRevisionKey,
  activeAcceptance,
  activeAcceptanceReferenceMap,
  activeContract,
  appendTicketContractRevision,
  buildContractRevision,
  contractIdentity,
  evidenceBoundReferenceMap,
  outcomeBindsContract,
  semanticDigest,
  stableValue,
} from "./revision-contract.mjs";

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
const CURRENT_EVIDENCE_SCHEMA = VERSION_CONTRACT.document_schemas.evidence;
const CURRENT_OUTCOME_SCHEMA = VERSION_CONTRACT.document_schemas.outcome;
const PROOF_REVISION_PENDING_REF = "migration-pending:format-3-to-format-4:reconstruct-proof-revisions";
const PROJECT_FORMAT_FILE = "version.yaml";
const PULL_REQUEST_REF = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u;
const COMMIT_REF = /^commit:[0-9a-f]{40}$/u;
const COMMIT_HASH = /^[0-9a-f]{40}$/u;
const VERSIONED_CONTEXT_REF = /^commit:([0-9a-f]{40}):(.+)$/u;

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
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") repo = argv[++index] ?? "";
    else if (value === "--input") inputPath = argv[++index] ?? "";
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
      "Usage: vh.mjs <context|room|ticket|project> <operation> --repo <path> [--input <json>] [--scope <current|all>] [--delivery <canonical-ref>] [--room <path>]...; context operations include put and resolve; project operations include init, compatibility, migrate-mechanical, migrate-proof-revisions, and validate",
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
  return stableValue(value);
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

function invalidContextRef(message, ref) {
  throw new VibeHubError("invalid_context_ref", `${message}: ${String(ref)}`);
}

function validateContextRefPath(path, ref) {
  if (!path || isAbsolute(path) || /^[A-Za-z]:/u.test(path)) {
    invalidContextRef("Ticket context ref path must be non-empty and repository-relative", ref);
  }
  if (path.includes("\\") || path.includes("//") || path.endsWith("/")) {
    invalidContextRef("Ticket context ref path must use canonical forward-slash separators", ref);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalidContextRef("Ticket context ref path must not contain empty, current, or parent traversal segments", ref);
  }
}

export function parseTicketContextRef(ref) {
  if (typeof ref !== "string" || ref.trim() === "") {
    invalidContextRef("Ticket context ref must be a non-empty string", ref);
  }
  if (ref.startsWith("commit:")) {
    const match = ref.match(VERSIONED_CONTEXT_REF);
    if (!match) {
      invalidContextRef("Versioned Ticket context ref must equal commit:<40-lowercase-hex>:<repo-relative-path>", ref);
    }
    const [, commit, path] = match;
    validateContextRefPath(path, ref);
    return { kind: "versioned", ref, commit, path };
  }
  validateContextRefPath(ref, ref);
  return { kind: "current", ref, commit: null, path: ref };
}

function gitBlobId(bytes) {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

export function resolveTicketContextRef(repo, ref) {
  const parsed = parseTicketContextRef(ref);
  if (parsed.kind === "current") {
    const target = resolve(repo, parsed.path);
    if (!target.startsWith(`${resolve(repo)}${sep}`) || !existsSync(target)) {
      throw new VibeHubError("context_ref_missing_path", `Ticket context ref path does not exist: ${parsed.path}`);
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      throw new VibeHubError("context_ref_symlink", `Ticket context ref path is a symlink: ${parsed.path}`);
    }
    if (!stat.isFile()) {
      throw new VibeHubError("context_ref_not_regular_file", `Ticket context ref path is not a regular file: ${parsed.path}`);
    }
    const bytes = readFileSync(target);
    const blob = gitBlobId(bytes);
    return {
      ref: parsed.ref,
      kind: parsed.kind,
      identity: { revision: "WORKTREE", path: parsed.path, blob },
      source: bytes.toString("utf8"),
      source_base64: bytes.toString("base64"),
    };
  }

  const objectType = git(repo, ["cat-file", "-t", parsed.commit], { allowFailure: true });
  if (objectType.status !== 0) {
    throw new VibeHubError("context_ref_missing_commit", `Ticket context ref commit is unavailable: ${parsed.commit}`);
  }
  if (objectType.stdout.trim() !== "commit") {
    throw new VibeHubError("context_ref_not_commit", `Ticket context ref revision is not a commit object: ${parsed.commit}`);
  }
  const listed = git(repo, ["ls-tree", "-z", parsed.commit, "--", parsed.path], { allowFailure: true });
  if (listed.status !== 0 || listed.stdout === "") {
    throw new VibeHubError("context_ref_missing_path", `Ticket context ref path is absent at ${parsed.commit}: ${parsed.path}`);
  }
  const entry = listed.stdout.split("\0").find(Boolean) ?? "";
  const tab = entry.indexOf("\t");
  const [mode, type, blob] = tab < 0 ? [] : entry.slice(0, tab).split(" ");
  if (type === "tree") {
    throw new VibeHubError("context_ref_directory", `Ticket context ref path is a directory at ${parsed.commit}: ${parsed.path}`);
  }
  if (mode === "120000") {
    throw new VibeHubError("context_ref_symlink", `Ticket context ref path is a symlink at ${parsed.commit}: ${parsed.path}`);
  }
  if (mode === "160000" || type === "commit") {
    throw new VibeHubError("context_ref_submodule", `Ticket context ref path is a submodule at ${parsed.commit}: ${parsed.path}`);
  }
  if (type !== "blob" || !new Set(["100644", "100755"]).has(mode)) {
    throw new VibeHubError("context_ref_not_regular_file", `Ticket context ref path is not a regular blob at ${parsed.commit}: ${parsed.path}`);
  }
  const bytes = git(repo, ["cat-file", "blob", blob], { binary: true }).stdout;
  return {
    ref: parsed.ref,
    kind: parsed.kind,
    identity: { commit: parsed.commit, path: parsed.path, blob },
    source: bytes.toString("utf8"),
    source_base64: bytes.toString("base64"),
  };
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

function validateMigrationsReference(reference) {
  const errors = [];
  if (!strictKeys(
    errors,
    reference,
    new Set(["schema_version", "owner", "current_format", "migrations"]),
    "migrations",
  )) return errors;
  if (reference.schema_version !== 2) add(errors, "migrations.schema_version", "must equal 2");
  if (reference.owner !== "vibehub-migrate") add(errors, "migrations.owner", "must equal vibehub-migrate");
  if (reference.current_format !== CURRENT_PROJECT_FORMAT) {
    add(errors, "migrations.current_format", `must equal ${CURRENT_PROJECT_FORMAT}`);
  }
  if (!Array.isArray(reference.migrations) || reference.migrations.length === 0) {
    add(errors, "migrations.migrations", "must be a non-empty array");
    return errors;
  }
  const ids = new Set();
  const fromFormats = new Set();
  reference.migrations.forEach((migration, index) => {
    const path = `migrations.migrations[${index}]`;
    if (!strictKeys(
      errors,
      migration,
      new Set(["migration_id", "from", "to", "detect", "document_schema_versions", "mechanical", "semantic"]),
      path,
    )) return;
    requiredString(errors, migration, "migration_id", path, { id: true });
    requiredString(errors, migration, "from", path);
    requiredString(errors, migration, "to", path);
    requiredString(errors, migration, "detect", path);
    if (ids.has(migration.migration_id)) add(errors, `${path}.migration_id`, "must be unique");
    if (fromFormats.has(migration.from)) add(errors, `${path}.from`, "must be unique");
    ids.add(migration.migration_id);
    fromFormats.add(migration.from);

    const mechanicalPath = `${path}.mechanical`;
    if (strictKeys(errors, migration.mechanical, new Set(["declared_paths", "actions"]), mechanicalPath)) {
      stringArray(errors, migration.mechanical.declared_paths, `${mechanicalPath}.declared_paths`);
      if (!Array.isArray(migration.mechanical.actions)) {
        add(errors, `${mechanicalPath}.actions`, "must be an array");
      } else migration.mechanical.actions.forEach((action, actionIndex) => {
        const actionPath = `${mechanicalPath}.actions[${actionIndex}]`;
        if (!isObject(action)) {
          add(errors, actionPath, "must be an object");
        } else if (action.type === "write-project-format") {
          strictKeys(errors, action, new Set(["type", "format_version"]), actionPath);
          if (!Number.isInteger(action.format_version) || action.format_version < 1) {
            add(errors, `${actionPath}.format_version`, "must be a positive integer");
          }
        } else if (action.type === "upgrade-ticket-schema") {
          strictKeys(
            errors,
            action,
            new Set(["type", "from", "to", "defaults", "pending_semantic_ref"]),
            actionPath,
          );
          if (!Number.isInteger(action.from) || !Number.isInteger(action.to)) {
            add(errors, actionPath, "from and to must be integers");
          }
          if (!isObject(action.defaults)) add(errors, `${actionPath}.defaults`, "must be an object");
          requiredString(errors, action, "pending_semantic_ref", actionPath);
        } else if (action.type === "upgrade-proof-revision-schemas") {
          strictKeys(
            errors,
            action,
            new Set([
              "type",
              "ticket_from",
              "ticket_to",
              "evidence_from",
              "evidence_to",
              "outcome_from",
              "outcome_to",
              "pending_semantic_ref",
            ]),
            actionPath,
          );
          for (const key of ["ticket_from", "ticket_to", "evidence_from", "evidence_to", "outcome_from", "outcome_to"]) {
            if (!Number.isInteger(action[key])) add(errors, `${actionPath}.${key}`, "must be an integer");
          }
          requiredString(errors, action, "pending_semantic_ref", actionPath);
        } else {
          add(errors, `${actionPath}.type`, "is not a supported mechanical migration action");
        }
      });
    }

    const semanticPath = `${path}.semantic`;
    if (strictKeys(errors, migration.semantic, new Set(["steps"]), semanticPath)) {
      if (!Array.isArray(migration.semantic.steps)) {
        add(errors, `${semanticPath}.steps`, "must be an array");
      } else migration.semantic.steps.forEach((step, stepIndex) => {
        const stepPath = `${semanticPath}.steps[${stepIndex}]`;
        if (!strictKeys(
          errors,
          step,
          new Set(["step_id", "pending_ref", "purpose", "derives_from", "good_value", "forbidden_shortcuts", "instructions"]),
          stepPath,
        )) return;
        requiredString(errors, step, "step_id", stepPath, { id: true });
        if (step.pending_ref !== undefined) requiredString(errors, step, "pending_ref", stepPath);
        requiredString(errors, step, "purpose", stepPath);
        stringArray(errors, step.derives_from, `${stepPath}.derives_from`, { nonEmpty: true });
        requiredString(errors, step, "good_value", stepPath);
        stringArray(errors, step.forbidden_shortcuts, `${stepPath}.forbidden_shortcuts`, { nonEmpty: true });
        stringArray(errors, step.instructions, `${stepPath}.instructions`, { nonEmpty: true });
      });
    }
    for (const action of migration.mechanical?.actions ?? []) {
      if (action.pending_semantic_ref !== undefined
        && !migration.semantic?.steps?.some((step) => step.pending_ref === action.pending_semantic_ref)) {
        add(
          errors,
          `${path}.mechanical.actions`,
          `pending semantic ref ${action.pending_semantic_ref} must name a semantic step in the same migration`,
        );
      }
    }
  });
  return errors;
}

function migrationFormatKey(detectedFormat) {
  return Number.isInteger(detectedFormat) ? `format-${detectedFormat}` : detectedFormat;
}

function migrationPathMatches(path, declared) {
  let source = "^";
  for (let index = 0; index < declared.length; index += 1) {
    const character = declared[index];
    if (character === "*" && declared[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u").test(path);
}

function relativeProjectPath(repo, path) {
  const prefix = `${resolve(repo)}${sep}`;
  const absolute = resolve(path);
  if (!absolute.startsWith(prefix)) {
    throw new VibeHubError("migration_error", `Migration path escapes the selected repository: ${absolute}`);
  }
  return absolute.slice(prefix.length).split(sep).join("/");
}

function pendingSemanticRefs(repo) {
  const refs = new Set();
  for (const path of yamlFiles(dirs(repo).tickets)) {
    const document = readDocument(path);
    for (const ref of Array.isArray(document.provenance_refs) ? document.provenance_refs : []) {
      if (ref.startsWith("migration-pending:")) refs.add(ref);
    }
  }
  return [...refs].sort();
}

function guidanceForPendingRefs(reference, refs) {
  const pending = new Set(refs);
  return reference.migrations.flatMap((migration) => migration.semantic.steps
    .filter((step) => step.pending_ref && pending.has(step.pending_ref))
    .map((step) => ({ migration_id: migration.migration_id, ...step })));
}

function migrateMechanical(repo) {
  const migrationsReference = JSON.parse(readFileSync(
    fileURLToPath(new URL("../../vibehub-migrate/references/migrations.json", import.meta.url)),
    "utf8",
  ));
  const referenceErrors = validateMigrationsReference(migrationsReference);
  assertValid(referenceErrors, "Migration reference is invalid");
  const compatibility = projectCompatibility(repo);
  if (compatibility.state === "UNSUPPORTED_NEWER") {
    throw new VibeHubError("format_mismatch", compatibility.reason, { compatibility });
  }
  if (compatibility.detected_format === "uninitialized") {
    throw new VibeHubError(
      "format_mismatch",
      "Uninitialized projects use project init; there is no migration path.",
      { compatibility },
    );
  }
  if (compatibility.state === "CURRENT") {
    const pending = pendingSemanticRefs(repo);
    return {
      status: pending.length > 0 ? "current_with_semantic_pending" : "current",
      changed_paths: [],
      applied_migrations: [],
      pending_semantic_refs: pending,
      pending_semantic_steps: guidanceForPendingRefs(migrationsReference, pending),
      target_format: CURRENT_PROJECT_FORMAT,
    };
  }

  const migrations = new Map(migrationsReference.migrations.map((item) => [item.from, item]));
  const plannedWrites = new Map();
  const applied = [];
  const pendingSteps = [];
  let format = migrationFormatKey(compatibility.detected_format);
  const visited = new Set();

  while (format !== `format-${CURRENT_PROJECT_FORMAT}`) {
    if (visited.has(format)) {
      throw new VibeHubError("migration_error", `Migration path contains a cycle at ${format}`);
    }
    visited.add(format);
    const migration = migrations.get(format);
    if (!migration) {
      throw new VibeHubError("migration_path_missing", `No declared migration starts at ${format}`);
    }
    const actions = migration.mechanical.actions;
    const semanticSteps = migration.semantic.steps.map((step) => ({
      migration_id: migration.migration_id,
      ...step,
    }));
    pendingSteps.push(...semanticSteps);
    if (actions.length === 0) {
      return {
        status: "semantic_required",
        detected_format: compatibility.detected_format,
        target_format: CURRENT_PROJECT_FORMAT,
        changed_paths: [],
        applied_migrations: [],
        pending_semantic_steps: pendingSteps,
        reason: `Migration ${migration.migration_id} has no mechanical actions and requires Agent judgment before the path can continue.`,
      };
    }

    for (const action of actions) {
      if (action.type === "write-project-format") {
        plannedWrites.set(projectFormatPath(repo), {
          document: {
            schema_version: 1,
            kind: "vibehub_project",
            format_version: action.format_version,
          },
          migration,
        });
      } else if (action.type === "upgrade-ticket-schema") {
        for (const path of yamlFiles(dirs(repo).tickets)) {
          const existing = plannedWrites.get(path)?.document ?? readDocument(path);
          if (![action.from, action.to].includes(existing.schema_version)) {
            throw new VibeHubError(
              "migration_error",
              `${path} has Ticket schema ${existing.schema_version}; expected ${action.from} or ${action.to}`,
            );
          }
          const document = { ...existing, schema_version: action.to };
          for (const [key, value] of Object.entries(action.defaults)) {
            if (document[key] === undefined) document[key] = structuredClone(value);
          }
          if (!Array.isArray(document.provenance_refs)) {
            throw new VibeHubError("migration_error", `${path}.provenance_refs must be an array`);
          }
          if (!document.provenance_refs.includes(action.pending_semantic_ref)) {
            document.provenance_refs = [...document.provenance_refs, action.pending_semantic_ref];
          }
          // A multi-hop migration may materialize an intermediate schema that
          // the current validator intentionally no longer accepts. Validate
          // the complete candidate only after every declared hop is applied.
          plannedWrites.set(path, { document, migration });
        }
      } else if (action.type === "upgrade-proof-revision-schemas") {
        for (const path of yamlFiles(dirs(repo).tickets)) {
          const existing = plannedWrites.get(path)?.document ?? readDocument(path);
          if (![action.ticket_from, action.ticket_to].includes(existing.schema_version)) {
            throw new VibeHubError(
              "migration_error",
              `${path} has Ticket schema ${existing.schema_version}; expected ${action.ticket_from} or ${action.ticket_to}`,
            );
          }
          if (existing.schema_version === action.ticket_to && existing.revision_state === "bound") continue;
          const document = {
            ...existing,
            schema_version: action.ticket_to,
            revision_state: "legacy-pending-reconstruction",
          };
          delete document.active_contract_revision;
          delete document.contract_revisions;
          if (!Array.isArray(document.provenance_refs)) {
            throw new VibeHubError("migration_error", `${path}.provenance_refs must be an array`);
          }
          if (!document.provenance_refs.includes(action.pending_semantic_ref)) {
            document.provenance_refs = [...document.provenance_refs, action.pending_semantic_ref];
          }
          assertValid(validateTicket(document, path), "Mechanically migrated Ticket is invalid");
          plannedWrites.set(path, { document, migration });
        }
        for (const path of nestedYamlFiles(dirs(repo).evidence)) {
          const existing = plannedWrites.get(path)?.document ?? readDocument(path);
          if (![action.evidence_from, action.evidence_to].includes(existing.schema_version)) {
            throw new VibeHubError(
              "migration_error",
              `${path} has Evidence schema ${existing.schema_version}; expected ${action.evidence_from} or ${action.evidence_to}`,
            );
          }
          if (existing.schema_version === action.evidence_to && existing.binding_state === "bound") continue;
          const document = {
            ...existing,
            schema_version: action.evidence_to,
            binding_state: "legacy-pending-reconstruction",
          };
          delete document.binding_origin;
          delete document.acceptance_revisions;
          delete document.unresolved;
          assertValid(validateEvidence(document, path), "Mechanically migrated Evidence is invalid");
          plannedWrites.set(path, { document, migration });
        }
        for (const path of nestedYamlFiles(dirs(repo).outcomes)) {
          const existing = plannedWrites.get(path)?.document ?? readDocument(path);
          if (![action.outcome_from, action.outcome_to].includes(existing.schema_version)) {
            throw new VibeHubError(
              "migration_error",
              `${path} has Outcome schema ${existing.schema_version}; expected ${action.outcome_from} or ${action.outcome_to}`,
            );
          }
          if (existing.schema_version === action.outcome_to && existing.binding_state === "bound") continue;
          const document = {
            ...existing,
            schema_version: action.outcome_to,
            outcome_id: "legacy-pending",
            binding_state: "legacy-pending-reconstruction",
          };
          delete document.binding_origin;
          delete document.contract_revision;
          delete document.unresolved;
          assertValid(validateOutcome(document, path), "Mechanically migrated Outcome is invalid");
          plannedWrites.set(path, { document, migration });
        }
      }
    }
    applied.push(migration.migration_id);
    format = migration.to;
  }

  const changedPaths = [];
  const originals = new Map();
  for (const [path, { document, migration }] of plannedWrites) {
    const relative = relativeProjectPath(repo, path);
    if (!migration.mechanical.declared_paths.some((declared) => migrationPathMatches(relative, declared))) {
      throw new VibeHubError(
        "migration_error",
        `Migration ${migration.migration_id} attempted undeclared path ${relative}`,
      );
    }
    if (!existsSync(path) || readFileSync(path, "utf8") !== serialize(document)) {
      originals.set(path, existsSync(path) ? readFileSync(path, "utf8") : null);
      changedPaths.push(relative);
    }
  }
  try {
    for (const [path, source] of originals) {
      writeDocument(path, plannedWrites.get(path).document);
    }
    const migratedCompatibility = projectCompatibility(repo);
    if (migratedCompatibility.state !== "CURRENT") {
      throw new VibeHubError(
        "migration_error",
        "Mechanical migration stopped before the current format",
        { compatibility: migratedCompatibility },
      );
    }
    const repository = loadRepository(repo);
    assertValid(repository.errors, "Mechanically migrated project is invalid");
  } catch (error) {
    for (const [path, source] of [...originals].reverse()) {
      if (source === null) {
        if (existsSync(path)) unlinkSync(path);
      } else {
        const temporary = `${path}.rollback-${process.pid}`;
        writeFileSync(temporary, source, { flag: "wx" });
        renameSync(temporary, path);
      }
    }
    throw error;
  }
  return {
    status: pendingSteps.length > 0 ? "migrated_with_semantic_pending" : "migrated",
    detected_format: compatibility.detected_format,
    target_format: CURRENT_PROJECT_FORMAT,
    changed_paths: changedPaths.sort(),
    applied_migrations: applied,
    pending_semantic_refs: pendingSemanticRefs(repo),
    pending_semantic_steps: pendingSteps,
  };
}

function gitDocumentAt(repo, commit, path) {
  if (!commit) return null;
  const result = git(repo, ["show", `${commit}:${path}`], { allowFailure: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function proofAddition(repo, path) {
  // Exact-path additions are intentional: a delete/re-add yields more than
  // one plausible birth event and must be reported as ambiguous, not silently
  // collapsed by --follow onto the newest lineage.
  const result = git(repo, ["log", "--diff-filter=A", "--format=%H", "HEAD", "--", path], {
    allowFailure: true,
  });
  const commits = result.stdout.trim().split("\n").filter(Boolean);
  if (commits.length === 0) return { state: "missing-history", commits: [] };
  if (commits.length > 1) return { state: "ambiguous-history", commits };
  return { state: "found", commits, commit: commits[0] };
}

function legacyAcceptanceSemantic(item) {
  return {
    acceptance_id: item.acceptance_id,
    criterion: item.criterion,
    ...(item.authority === undefined ? {} : { authority: item.authority }),
  };
}

function acceptanceSemanticKey(item) {
  return semanticDigest({
    acceptance_id: item.acceptance_id,
    criterion: item.criterion,
    authority: item.authority ?? "agent",
  });
}

function contractMembershipKey(references) {
  return JSON.stringify([...references]
    .map(({ acceptance_id, revision, identity }) => ({ acceptance_id, revision, identity }))
    .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
      || left.revision - right.revision));
}

function unresolvedBinding(addition, path) {
  return {
    reason: addition.state,
    attempted_refs: addition.commits.length > 0
      ? addition.commits.map((commit) => `commit:${commit}:${path}`)
      : [`git-addition:${path}`],
  };
}

function restoreFiles(originals) {
  for (const [path, source] of [...originals].reverse()) {
    if (source === null) {
      if (existsSync(path)) unlinkSync(path);
    } else {
      const temporary = `${path}.rollback-${process.pid}`;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temporary, source, { flag: "wx" });
      renameSync(temporary, path);
    }
  }
}

function migrateProofRevisions(repo) {
  assertCurrentProjectFormat(repo);
  const before = loadRepository(repo);
  assertValid(before.errors);
  const pendingTickets = documents(before.tickets.documents)
    .filter((ticket) => ticket.revision_state === "legacy-pending-reconstruction");
  if (pendingTickets.length === 0) {
    return {
      status: "current",
      changed_paths: [],
      tickets_reconstructed: 0,
      evidence_bound: 0,
      outcomes_bound: 0,
      unresolved: 0,
    };
  }

  const commitOrder = new Map(git(repo, ["rev-list", "--reverse", "HEAD"]).stdout
    .trim().split("\n").filter(Boolean).map((commit, index) => [commit, index]));
  const writes = new Map();
  const deletions = new Set();
  const outcomePathMoves = new Map();
  let evidenceBound = 0;
  let outcomesBound = 0;
  let unresolved = 0;

  for (const pendingTicket of pendingTickets) {
    const ticketId = pendingTicket.ticket_id;
    const ticketPath = `.vibehub/tickets/${ticketId}.yaml`;
    const ticketEvidence = documents(before.evidence.documents)
      .filter((item) => item.ticket_id === ticketId);
    const ticketOutcomes = outcomesForTicket(before, ticketId);
    const proofEvents = [];
    for (const evidence of ticketEvidence) {
      const path = `.vibehub/evidence/${ticketId}/${evidence.evidence_id}.yaml`;
      const addition = proofAddition(repo, path);
      proofEvents.push({ kind: "evidence", document: evidence, path, addition });
    }
    for (const outcome of ticketOutcomes) {
      const entry = before.outcomes.history.get(`${ticketId}:${outcome.outcome_id}`);
      const path = relative(repo, entry.path).split(sep).join("/");
      const addition = proofAddition(repo, path);
      proofEvents.push({ kind: "outcome", document: outcome, path, addition });
    }

    const versionsById = new Map();
    const addAcceptance = (item, rank) => {
      if (!item || typeof item.acceptance_id !== "string" || typeof item.criterion !== "string") return;
      const semantic = legacyAcceptanceSemantic(item);
      const key = acceptanceSemanticKey(semantic);
      const versions = versionsById.get(semantic.acceptance_id) ?? new Map();
      const existing = versions.get(key);
      if (!existing || rank < existing.rank) versions.set(key, { semantic, rank, key });
      versionsById.set(semantic.acceptance_id, versions);
    };
    const currentRank = commitOrder.size + 1;
    for (const item of pendingTicket.acceptance) addAcceptance(item, currentRank);

    for (const event of proofEvents) {
      if (event.addition.state !== "found") continue;
      const historical = gitDocumentAt(repo, event.addition.commit, ticketPath);
      event.historicalTicket = historical;
      event.rank = commitOrder.get(event.addition.commit) ?? currentRank;
      if (!historical || !Array.isArray(historical.acceptance)) continue;
      const ids = event.kind === "evidence"
        ? new Set(event.document.acceptance_ids)
        : null;
      for (const item of historical.acceptance) {
        if (ids === null || ids.has(item.acceptance_id)) addAcceptance(item, event.rank);
      }
    }

    const currentById = new Map(pendingTicket.acceptance.map((item) => [item.acceptance_id, acceptanceSemanticKey(item)]));
    const acceptance = [];
    const resolvedVersions = new Map();
    for (const acceptanceId of [...versionsById.keys()].sort()) {
      const versions = [...versionsById.get(acceptanceId).values()]
        .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
      versions.forEach((entry, index) => {
        const revision = {
          ...entry.semantic,
          revision: index + 1,
          state: currentById.get(acceptanceId) === entry.key ? "active" : "retired",
        };
        const materialized = {
          ...revision,
          identity: acceptanceIdentity(ticketId, revision),
        };
        acceptance.push(materialized);
        resolvedVersions.set(`${acceptanceId}:${entry.key}`, materialized);
      });
    }
    acceptance.sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
      || left.revision - right.revision);

    const resolveSnapshot = (historical) => {
      if (!historical || !Array.isArray(historical.acceptance)) return null;
      const references = [];
      for (const item of historical.acceptance) {
        const resolved = resolvedVersions.get(`${item.acceptance_id}:${acceptanceSemanticKey(item)}`);
        if (!resolved) return null;
        references.push(acceptanceReference(resolved));
      }
      return references.sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
        || left.revision - right.revision);
    };

    const outcomeEvents = proofEvents
      .filter((event) => event.kind === "outcome" && event.historicalTicket)
      .sort((left, right) => left.rank - right.rank || left.path.localeCompare(right.path));
    const contractRevisions = [];
    const outcomeContracts = new Map();
    let priorMembership = null;
    for (const event of outcomeEvents) {
      const references = resolveSnapshot(event.historicalTicket);
      if (!references) continue;
      const membership = contractMembershipKey(references);
      if (membership !== priorMembership) {
        const contract = { revision: contractRevisions.length + 1, acceptance_revisions: references };
        contractRevisions.push({ ...contract, identity: contractIdentity(ticketId, contract) });
        priorMembership = membership;
      }
      outcomeContracts.set(event.path, contractRevisions.at(-1));
    }
    const currentReferences = pendingTicket.acceptance.map((item) =>
      acceptanceReference(resolvedVersions.get(`${item.acceptance_id}:${acceptanceSemanticKey(item)}`)))
      .sort((left, right) => left.acceptance_id.localeCompare(right.acceptance_id)
        || left.revision - right.revision);
    const currentMembership = contractMembershipKey(currentReferences);
    if (currentMembership !== priorMembership || contractRevisions.length === 0) {
      const contract = { revision: contractRevisions.length + 1, acceptance_revisions: currentReferences };
      contractRevisions.push({ ...contract, identity: contractIdentity(ticketId, contract) });
    }
    const activeContractRevision = contractRevisions.at(-1).revision;
    const reconstructedTicket = {
      ...pendingTicket,
      revision_state: "bound",
      acceptance,
      active_contract_revision: activeContractRevision,
      contract_revisions: contractRevisions,
      provenance_refs: pendingTicket.provenance_refs.filter((ref) => ref !== PROOF_REVISION_PENDING_REF),
    };
    assertValid(validateTicket(reconstructedTicket, ticketPath), "Reconstructed Ticket is invalid");
    writes.set(join(repo, ticketPath), reconstructedTicket);

    for (const event of proofEvents) {
      const absolute = join(repo, event.path);
      if (event.addition.state !== "found" || !event.historicalTicket) {
        unresolved += 1;
        const result = {
          ...event.document,
          schema_version: event.kind === "evidence" ? CURRENT_EVIDENCE_SCHEMA : CURRENT_OUTCOME_SCHEMA,
          binding_state: "legacy-unresolved",
          unresolved: unresolvedBinding(event.addition, event.path),
        };
        delete result.binding_origin;
        delete result.acceptance_revisions;
        delete result.contract_revision;
        if (event.kind === "outcome") result.outcome_id = "legacy-unresolved";
        writes.set(absolute, result);
        continue;
      }
      if (event.kind === "evidence") {
        const historicalById = new Map(event.historicalTicket.acceptance.map((item) => [item.acceptance_id, item]));
        const references = event.document.acceptance_ids.map((acceptanceId) => {
          const historical = historicalById.get(acceptanceId);
          return historical
            ? resolvedVersions.get(`${acceptanceId}:${acceptanceSemanticKey(historical)}`)
            : null;
        });
        if (references.some((item) => !item)) {
          unresolved += 1;
          const result = {
            ...event.document,
            schema_version: CURRENT_EVIDENCE_SCHEMA,
            binding_state: "legacy-unresolved",
            unresolved: {
              reason: "missing-history",
              attempted_refs: [`commit:${event.addition.commit}:${ticketPath}`],
            },
          };
          delete result.binding_origin;
          delete result.acceptance_revisions;
          writes.set(absolute, result);
        } else {
          evidenceBound += 1;
          const result = {
            ...event.document,
            schema_version: CURRENT_EVIDENCE_SCHEMA,
            binding_state: "bound",
            binding_origin: "reconstructed",
            acceptance_revisions: references.map(acceptanceReference),
          };
          delete result.unresolved;
          writes.set(absolute, result);
        }
      } else {
        const contract = outcomeContracts.get(event.path);
        const referencedEvidence = event.document.evidence_ids
          .map((evidenceId) => proofEvents.find((candidate) =>
            candidate.kind === "evidence" && candidate.document.evidence_id === evidenceId));
        const evidenceResolvable = referencedEvidence.every((candidate) =>
          candidate && candidate.addition.state === "found" && candidate.historicalTicket);
        if (!contract || !evidenceResolvable) {
          unresolved += 1;
          const result = {
            ...event.document,
            schema_version: CURRENT_OUTCOME_SCHEMA,
            outcome_id: "legacy-unresolved",
            binding_state: "legacy-unresolved",
            unresolved: {
              reason: "missing-history",
              attempted_refs: [`commit:${event.addition.commit}:${ticketPath}`],
            },
          };
          delete result.binding_origin;
          delete result.contract_revision;
          writes.set(absolute, result);
        } else {
          outcomesBound += 1;
          const result = {
            ...event.document,
            schema_version: CURRENT_OUTCOME_SCHEMA,
            outcome_id: `contract-v${contract.revision}`,
            binding_state: "bound",
            binding_origin: "reconstructed",
            contract_revision: { revision: contract.revision, identity: contract.identity },
          };
          delete result.unresolved;
          const target = join(repo, ".vibehub", "outcomes", ticketId, `${result.outcome_id}.yaml`);
          writes.set(target, result);
          if (target !== absolute) {
            deletions.add(absolute);
            outcomePathMoves.set(event.path, relativeProjectPath(repo, target));
          }
        }
      }
    }
  }

  for (const [path, document] of writes) {
    if (!path.startsWith(`${dirs(repo).tickets}${sep}`)) continue;
    const rewrittenRefs = document.context_refs.map((contextRef) => ({
      ...contextRef,
      ref: outcomePathMoves.get(contextRef.ref) ?? contextRef.ref,
    }));
    if (JSON.stringify(rewrittenRefs) !== JSON.stringify(document.context_refs)) {
      writes.set(path, { ...document, context_refs: rewrittenRefs });
    }
  }

  const touched = new Set([...writes.keys(), ...deletions]);
  const originals = new Map([...touched].map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : null]));
  try {
    for (const [path, document] of writes) writeDocument(path, document);
    for (const path of deletions) if (existsSync(path)) unlinkSync(path);
    const migrated = loadRepository(repo);
    assertValid(migrated.errors, "Proof revision migration produced an invalid project");
  } catch (error) {
    restoreFiles(originals);
    throw error;
  }
  return {
    status: unresolved > 0 ? "migrated_with_unresolved" : "migrated",
    changed_paths: [...touched].map((path) => relativeProjectPath(repo, path)).sort(),
    tickets_reconstructed: pendingTickets.length,
    evidence_bound: evidenceBound,
    outcomes_bound: outcomesBound,
    unresolved,
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
        "revision_state",
        "active_contract_revision",
        "contract_revisions",
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
  if (!["bound", "legacy-pending-reconstruction"].includes(document.revision_state)) {
    add(errors, `${path}.revision_state`, "must equal bound or legacy-pending-reconstruction");
  }
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
  } else if (document.revision_state === "legacy-pending-reconstruction") {
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
    if (document.active_contract_revision !== undefined) {
      add(errors, `${path}.active_contract_revision`, "is forbidden while legacy reconstruction is pending");
    }
    if (document.contract_revisions !== undefined) {
      add(errors, `${path}.contract_revisions`, "is forbidden while legacy reconstruction is pending");
    }
    if (!Array.isArray(document.provenance_refs)
      || !document.provenance_refs.includes(PROOF_REVISION_PENDING_REF)) {
      add(errors, `${path}.provenance_refs`, `must contain ${PROOF_REVISION_PENDING_REF} while legacy reconstruction is pending`);
    }
  } else if (document.revision_state === "bound") {
    const keys = new Set();
    const byKey = new Map();
    const revisionsById = new Map();
    const activeIds = new Set();
    document.acceptance.forEach((item, index) => {
      const itemPath = `${path}.acceptance[${index}]`;
      if (!strictKeys(
        errors,
        item,
        new Set(["acceptance_id", "revision", "identity", "criterion", "authority", "state", "derived_from", "presentation"]),
        itemPath,
      )) return;
      requiredString(errors, item, "acceptance_id", itemPath, { id: true });
      if (!Number.isInteger(item.revision) || item.revision < 1) {
        add(errors, `${itemPath}.revision`, "must be a positive integer");
      }
      requiredString(errors, item, "identity", itemPath);
      if (!REVISION_IDENTITY.test(item.identity ?? "")) add(errors, `${itemPath}.identity`, "must be sha256:<64-lowercase-hex>");
      requiredString(errors, item, "criterion", itemPath);
      if (item.authority !== undefined && !ACCEPTANCE_AUTHORITIES.has(item.authority)) {
        add(errors, `${itemPath}.authority`, "must equal agent or human when present");
      }
      if (!["active", "retired"].includes(item.state)) add(errors, `${itemPath}.state`, "must equal active or retired");
      if (item.presentation !== undefined) {
        const presentationPath = `${itemPath}.presentation`;
        if (strictKeys(errors, item.presentation, new Set(["label", "description"]), presentationPath)) {
          if (Object.keys(item.presentation).length === 0) add(errors, presentationPath, "must contain label or description");
          if (item.presentation.label !== undefined) requiredString(errors, item.presentation, "label", presentationPath);
          if (item.presentation.description !== undefined) requiredString(errors, item.presentation, "description", presentationPath);
        }
      }
      if (item.derived_from !== undefined && !Array.isArray(item.derived_from)) {
        add(errors, `${itemPath}.derived_from`, "must be an array");
      } else {
        const lineage = new Set();
        for (const [lineageIndex, reference] of (item.derived_from ?? []).entries()) {
          const lineagePath = `${itemPath}.derived_from[${lineageIndex}]`;
          if (!strictKeys(errors, reference, new Set(["acceptance_id", "revision"]), lineagePath)) continue;
          requiredString(errors, reference, "acceptance_id", lineagePath, { id: true });
          if (!Number.isInteger(reference.revision) || reference.revision < 1) {
            add(errors, `${lineagePath}.revision`, "must be a positive integer");
          }
          const key = acceptanceRevisionKey(reference);
          if (lineage.has(key)) add(errors, lineagePath, "must be unique");
          lineage.add(key);
        }
      }
      const key = acceptanceRevisionKey(item);
      if (keys.has(key)) add(errors, itemPath, "acceptance_id and revision pair must be unique");
      keys.add(key);
      byKey.set(key, item);
      const revisions = revisionsById.get(item.acceptance_id) ?? [];
      revisions.push(item.revision);
      revisionsById.set(item.acceptance_id, revisions);
      if (item.state === "active") {
        if (activeIds.has(item.acceptance_id)) add(errors, itemPath, "only one revision per acceptance_id may be active");
        activeIds.add(item.acceptance_id);
      }
      if (item.identity !== acceptanceIdentity(document.ticket_id, item)) {
        add(errors, `${itemPath}.identity`, "does not match canonical immutable Acceptance revision content");
      }
    });
    for (const [acceptanceId, revisions] of revisionsById) {
      const sorted = [...revisions].sort((left, right) => left - right);
      sorted.forEach((revision, index) => {
        if (revision !== index + 1) add(errors, `${path}.acceptance`, `${acceptanceId} revisions must be contiguous from 1`);
      });
    }
    for (const item of document.acceptance) {
      for (const reference of item.derived_from ?? []) {
        const source = byKey.get(acceptanceRevisionKey(reference));
        if (!source) add(errors, `${path}.acceptance`, `derived_from references missing revision ${acceptanceRevisionKey(reference)}`);
        else {
          if (source.acceptance_id === item.acceptance_id) {
            add(errors, `${path}.acceptance`, "derived_from is only for split or merge across logical Acceptance IDs");
          }
          if (source.state !== "retired") add(errors, `${path}.acceptance`, `derived_from source ${acceptanceRevisionKey(reference)} must be retired`);
        }
      }
    }
    if (!Number.isInteger(document.active_contract_revision) || document.active_contract_revision < 1) {
      add(errors, `${path}.active_contract_revision`, "must be a positive integer");
    }
    if (!Array.isArray(document.contract_revisions) || document.contract_revisions.length === 0) {
      add(errors, `${path}.contract_revisions`, "must contain at least one Contract revision");
    } else {
      const contractNumbers = new Set();
      document.contract_revisions.forEach((contract, index) => {
        const contractPath = `${path}.contract_revisions[${index}]`;
        if (!strictKeys(errors, contract, new Set(["revision", "identity", "acceptance_revisions"]), contractPath)) return;
        if (!Number.isInteger(contract.revision) || contract.revision < 1) add(errors, `${contractPath}.revision`, "must be a positive integer");
        if (contractNumbers.has(contract.revision)) add(errors, `${contractPath}.revision`, "must be unique");
        contractNumbers.add(contract.revision);
        requiredString(errors, contract, "identity", contractPath);
        if (!REVISION_IDENTITY.test(contract.identity ?? "")) add(errors, `${contractPath}.identity`, "must be sha256:<64-lowercase-hex>");
        if (!Array.isArray(contract.acceptance_revisions)) add(errors, `${contractPath}.acceptance_revisions`, "must be an array");
        else {
          const members = new Set();
          contract.acceptance_revisions.forEach((reference, referenceIndex) => {
            const referencePath = `${contractPath}.acceptance_revisions[${referenceIndex}]`;
            if (!strictKeys(errors, reference, new Set(["acceptance_id", "revision", "identity"]), referencePath)) return;
            requiredString(errors, reference, "acceptance_id", referencePath, { id: true });
            if (!Number.isInteger(reference.revision) || reference.revision < 1) add(errors, `${referencePath}.revision`, "must be a positive integer");
            if (!REVISION_IDENTITY.test(reference.identity ?? "")) add(errors, `${referencePath}.identity`, "must be sha256:<64-lowercase-hex>");
            const key = acceptanceRevisionKey(reference);
            if (members.has(key)) add(errors, referencePath, "must be unique within one Contract revision");
            members.add(key);
            const acceptance = byKey.get(key);
            if (!acceptance) add(errors, referencePath, `references missing Acceptance revision ${key}`);
            else if (acceptance.identity !== reference.identity) add(errors, `${referencePath}.identity`, `does not match Acceptance revision ${key}`);
          });
        }
        if (contract.identity !== contractIdentity(document.ticket_id, contract)) {
          add(errors, `${contractPath}.identity`, "does not match canonical immutable Contract revision content");
        }
      });
      const sorted = [...contractNumbers].sort((left, right) => left - right);
      sorted.forEach((revision, index) => {
        if (revision !== index + 1) add(errors, `${path}.contract_revisions`, "Contract revisions must be contiguous from 1");
      });
      if (document.active_contract_revision !== Math.max(...contractNumbers)) {
        add(errors, `${path}.active_contract_revision`, "must select the latest Contract revision; reversion appends a new revision");
      }
      const active = document.contract_revisions.find((contract) => contract.revision === document.active_contract_revision);
      const expected = buildContractRevision(document.ticket_id, document.active_contract_revision, document.acceptance);
      if (active && JSON.stringify(stable(active.acceptance_revisions)) !== JSON.stringify(stable(expected.acceptance_revisions))) {
        add(errors, `${path}.active_contract_revision`, "active Contract membership must equal the exact active Acceptance revisions");
      }
    }
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

function validateUnresolvedBinding(errors, unresolved, path) {
  if (!strictKeys(errors, unresolved, new Set(["reason", "attempted_refs"]), path)) return;
  if (!["missing-history", "ambiguous-history"].includes(unresolved.reason)) {
    add(errors, `${path}.reason`, "must equal missing-history or ambiguous-history");
  }
  stringArray(errors, unresolved.attempted_refs, `${path}.attempted_refs`, { nonEmpty: true });
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
        "binding_state",
        "binding_origin",
        "acceptance_revisions",
        "unresolved",
        "summary",
        "refs",
        "origin",
        "recorded_at",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== CURRENT_EVIDENCE_SCHEMA) {
    add(errors, `${path}.schema_version`, `must equal ${CURRENT_EVIDENCE_SCHEMA}`);
  }
  if (document.kind !== "ticket_evidence") add(errors, `${path}.kind`, "must equal ticket_evidence");
  requiredString(errors, document, "evidence_id", path, { id: true });
  requiredString(errors, document, "ticket_id", path, { id: true });
  stringArray(errors, document.acceptance_ids, `${path}.acceptance_ids`, { nonEmpty: true, ids: true });
  if (!REVISION_BINDING_STATES.has(document.binding_state)) {
    add(errors, `${path}.binding_state`, "must equal bound, legacy-pending-reconstruction, or legacy-unresolved");
  }
  if (document.binding_state === "bound") {
    if (!REVISION_BINDING_ORIGINS.has(document.binding_origin)) {
      add(errors, `${path}.binding_origin`, "must equal native or reconstructed");
    }
    if (!Array.isArray(document.acceptance_revisions) || document.acceptance_revisions.length === 0) {
      add(errors, `${path}.acceptance_revisions`, "must be a non-empty array for bound Evidence");
    } else {
      const ids = new Set();
      document.acceptance_revisions.forEach((reference, index) => {
        const referencePath = `${path}.acceptance_revisions[${index}]`;
        if (!strictKeys(errors, reference, new Set(["acceptance_id", "revision", "identity"]), referencePath)) return;
        requiredString(errors, reference, "acceptance_id", referencePath, { id: true });
        if (!Number.isInteger(reference.revision) || reference.revision < 1) add(errors, `${referencePath}.revision`, "must be a positive integer");
        if (!REVISION_IDENTITY.test(reference.identity ?? "")) add(errors, `${referencePath}.identity`, "must be sha256:<64-lowercase-hex>");
        if (ids.has(reference.acceptance_id)) add(errors, `${referencePath}.acceptance_id`, "must be unique");
        ids.add(reference.acceptance_id);
      });
      if (JSON.stringify([...ids].sort()) !== JSON.stringify([...document.acceptance_ids].sort())) {
        add(errors, `${path}.acceptance_revisions`, "must bind exactly the asserted acceptance_ids");
      }
    }
    if (document.unresolved !== undefined) add(errors, `${path}.unresolved`, "is forbidden for bound Evidence");
  } else {
    if (document.binding_origin !== undefined) add(errors, `${path}.binding_origin`, "is allowed only for bound Evidence");
    if (document.acceptance_revisions !== undefined) add(errors, `${path}.acceptance_revisions`, "is allowed only for bound Evidence");
    if (document.binding_state === "legacy-unresolved") validateUnresolvedBinding(errors, document.unresolved, `${path}.unresolved`);
    else if (document.unresolved !== undefined) add(errors, `${path}.unresolved`, "is allowed only for legacy-unresolved Evidence");
  }
  requiredString(errors, document, "summary", path);
  stringArray(errors, document.refs, `${path}.refs`, { nonEmpty: true });
  if (document.origin !== undefined && !EVIDENCE_ORIGINS.has(document.origin)) {
    add(errors, `${path}.origin`, "must equal agent or human when present");
  }
  requiredString(errors, document, "recorded_at", path);
  if (Number.isNaN(Date.parse(document.recorded_at))) add(errors, `${path}.recorded_at`, "must be an ISO-compatible date-time");
  return errors;
}

// A closeout Agent must be independent from the executor. The engine cannot
// verify that claim and must not try; it requires the claim to be made, so an
// absent one is a rejected write rather than a silent self-adjudication.
export const INDEPENDENCE_SOURCES = new Set(["subagent", "separate_session", "different_human"]);

function validateOutcome(document, path = "outcome") {
  const errors = [];
  if (
    !strictKeys(
      errors,
      document,
      new Set([
        "schema_version",
        "kind",
        "outcome_id",
        "ticket_id",
        "binding_state",
        "binding_origin",
        "contract_revision",
        "unresolved",
        "status",
        "accepted_acceptance_ids",
        "unresolved_acceptance_ids",
        "evidence_ids",
        "summary",
        "closed_at",
        "independence",
      ]),
      path,
    )
  ) return errors;
  if (document.schema_version !== CURRENT_OUTCOME_SCHEMA) {
    add(errors, `${path}.schema_version`, `must equal ${CURRENT_OUTCOME_SCHEMA}`);
  }
  if (document.kind !== "ticket_outcome") add(errors, `${path}.kind`, "must equal ticket_outcome");
  requiredString(errors, document, "outcome_id", path, { id: true });
  requiredString(errors, document, "ticket_id", path, { id: true });
  if (!REVISION_BINDING_STATES.has(document.binding_state)) {
    add(errors, `${path}.binding_state`, "must equal bound, legacy-pending-reconstruction, or legacy-unresolved");
  }
  if (document.binding_state === "bound") {
    if (!REVISION_BINDING_ORIGINS.has(document.binding_origin)) add(errors, `${path}.binding_origin`, "must equal native or reconstructed");
    if (!strictKeys(errors, document.contract_revision, new Set(["revision", "identity"]), `${path}.contract_revision`)) {
      // strictKeys records the shape error.
    } else {
      if (!Number.isInteger(document.contract_revision.revision) || document.contract_revision.revision < 1) {
        add(errors, `${path}.contract_revision.revision`, "must be a positive integer");
      }
      if (!REVISION_IDENTITY.test(document.contract_revision.identity ?? "")) {
        add(errors, `${path}.contract_revision.identity`, "must be sha256:<64-lowercase-hex>");
      }
      if (document.outcome_id !== `contract-v${document.contract_revision.revision}`) {
        add(errors, `${path}.outcome_id`, "must equal contract-v<bound-revision>");
      }
    }
    if (document.unresolved !== undefined) add(errors, `${path}.unresolved`, "is forbidden for bound Outcome");
  } else {
    if (document.binding_origin !== undefined) add(errors, `${path}.binding_origin`, "is allowed only for bound Outcome");
    if (document.contract_revision !== undefined) add(errors, `${path}.contract_revision`, "is allowed only for bound Outcome");
    if (document.binding_state === "legacy-pending-reconstruction") {
      if (document.outcome_id !== "legacy-pending") add(errors, `${path}.outcome_id`, "must equal legacy-pending while reconstruction is pending");
      if (document.unresolved !== undefined) add(errors, `${path}.unresolved`, "is allowed only for legacy-unresolved Outcome");
    } else {
      if (document.outcome_id !== "legacy-unresolved") add(errors, `${path}.outcome_id`, "must equal legacy-unresolved when reconstruction failed");
      validateUnresolvedBinding(errors, document.unresolved, `${path}.unresolved`);
    }
  }
  if (!OUTCOME_STATUSES.has(document.status)) add(errors, `${path}.status`, "is not supported");
  stringArray(errors, document.accepted_acceptance_ids, `${path}.accepted_acceptance_ids`, { ids: true });
  stringArray(errors, document.unresolved_acceptance_ids, `${path}.unresolved_acceptance_ids`, { ids: true });
  stringArray(errors, document.evidence_ids, `${path}.evidence_ids`, { ids: true });
  requiredString(errors, document, "summary", path);
  requiredString(errors, document, "closed_at", path);
  if (Number.isNaN(Date.parse(document.closed_at))) add(errors, `${path}.closed_at`, "must be an ISO-compatible date-time");
  // Optional on read so the Outcomes written before this contract stay valid;
  // `ticket closeout` requires it when writing a new one.
  if (document.independence !== undefined) {
    const independence = document.independence;
    if (typeof independence !== "object" || independence === null || Array.isArray(independence)) {
      add(errors, `${path}.independence`, "must be an object");
    } else if (!strictKeys(errors, independence, new Set(["source", "note"]), `${path}.independence`)) {
      // strictKeys already recorded the unknown key
    } else {
      if (!INDEPENDENCE_SOURCES.has(independence.source)) {
        add(errors, `${path}.independence.source`, `must be one of ${[...INDEPENDENCE_SOURCES].join(", ")}`);
      }
      if (independence.note !== undefined) requiredString(errors, independence, "note", `${path}.independence`);
    }
  }
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

function loadOutcomes(path) {
  const history = new Map();
  const byTicket = new Map();
  const errors = [];
  for (const file of nestedYamlFiles(path)) {
    let document;
    try {
      document = readDocument(file);
    } catch (error) {
      add(errors, file, error instanceof Error ? error.message : String(error));
      continue;
    }
    errors.push(...validateOutcome(document, file));
    if (typeof document?.ticket_id !== "string" || typeof document?.outcome_id !== "string") continue;
    const key = `${document.ticket_id}:${document.outcome_id}`;
    if (history.has(key)) add(errors, file, `duplicate Outcome identity: ${key}`);
    else history.set(key, { document, path: file });
    const entries = byTicket.get(document.ticket_id) ?? [];
    entries.push({ document, path: file });
    byTicket.set(document.ticket_id, entries);
    const expected = document.binding_state === "bound"
      ? join(path, document.ticket_id, `${document.outcome_id}.yaml`)
      : join(path, `${document.ticket_id}.yaml`);
    if (file !== expected) add(errors, file, `Outcome path must be ${expected}`);
  }
  for (const entries of byTicket.values()) {
    entries.sort((left, right) => {
      const leftRevision = left.document.contract_revision?.revision ?? 0;
      const rightRevision = right.document.contract_revision?.revision ?? 0;
      return leftRevision - rightRevision || left.document.outcome_id.localeCompare(right.document.outcome_id);
    });
  }
  const documents = new Map();
  for (const [ticketId, entries] of byTicket) {
    const latest = [...entries].reverse().find(({ document }) => document.binding_state === "bound")
      ?? entries.at(-1);
    if (latest) documents.set(ticketId, latest);
  }
  return { documents, history, byTicket, errors };
}

export function outcomeDocuments(repository) {
  if (repository.outcomes.history) return documents(repository.outcomes.history);
  return documents(repository.outcomes.documents);
}

export function outcomesForTicket(repository, ticketId) {
  if (repository.outcomes.byTicket) {
    return (repository.outcomes.byTicket.get(ticketId) ?? []).map((entry) => entry.document);
  }
  const document = repository.outcomes.documents.get(ticketId)?.document;
  return document ? [document] : [];
}

export function currentOutcome(repository, ticket) {
  const contract = activeContract(ticket);
  if (!contract) return null;
  return outcomesForTicket(repository, ticket.ticket_id)
    .find((outcome) => outcomeBindsContract(outcome, contract)) ?? null;
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
  const outcomes = loadOutcomes(paths.outcomes);
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
    const key = `${document.ticket_id}:${document.outcome_id}`;
    const entry = { document, path: `<candidate:${key}>` };
    outcomes.history.set(key, entry);
    const entries = (outcomes.byTicket.get(document.ticket_id) ?? [])
      .filter((item) => item.document.outcome_id !== document.outcome_id);
    entries.push(entry);
    outcomes.byTicket.set(document.ticket_id, entries);
    outcomes.documents.set(document.ticket_id, entry);
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
      try {
        resolveTicketContextRef(repo, ref);
      } catch (error) {
        add(errors, path, error instanceof Error ? error.message : `unreadable Ticket context ref: ${String(ref)}`);
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
    if (document.binding_state === "legacy-pending-reconstruction") {
      if (ticket.revision_state !== "legacy-pending-reconstruction"
        || !ticket.provenance_refs.includes(PROOF_REVISION_PENDING_REF)) {
        add(errors, path, "Pending Evidence requires the owning Ticket's matching semantic-pending ref");
      }
      continue;
    }
    if (document.binding_state === "legacy-unresolved") continue;
    if (document.binding_state !== "bound" || !Array.isArray(document.acceptance_revisions)) continue;
    const acceptance = new Map(ticket.acceptance.map((item) => [acceptanceRevisionKey(item), item]));
    for (const reference of document.acceptance_revisions) {
      const item = acceptance.get(acceptanceRevisionKey(reference));
      if (!item) add(errors, path, `Evidence references missing Acceptance revision: ${acceptanceRevisionKey(reference)}`);
      else if (item.identity !== reference.identity) add(errors, path, `Evidence identity does not match Acceptance revision: ${acceptanceRevisionKey(reference)}`);
    }
  }
  const outcomeContracts = new Set();
  for (const { document, path } of outcomes.history.values()) {
    const ticket = tickets.documents.get(document.ticket_id)?.document;
    if (!ticket) {
      add(errors, path, `Outcome references missing Ticket: ${document.ticket_id}`);
      continue;
    }
    if (document.binding_state === "legacy-pending-reconstruction") {
      if (ticket.revision_state !== "legacy-pending-reconstruction"
        || !ticket.provenance_refs.includes(PROOF_REVISION_PENDING_REF)) {
        add(errors, path, "Pending Outcome requires the owning Ticket's matching semantic-pending ref");
      }
      continue;
    }
    if (document.binding_state === "legacy-unresolved") continue;
    if (document.binding_state !== "bound" || !document.contract_revision
      || !Array.isArray(ticket.contract_revisions)) continue;
    const contract = ticket.contract_revisions.find((item) =>
      item.revision === document.contract_revision.revision);
    if (!contract || contract.identity !== document.contract_revision.identity) {
      add(errors, path, `Outcome references missing or mismatched Contract revision: v${document.contract_revision.revision}`);
      continue;
    }
    const outcomeContractKey = `${document.ticket_id}@${document.contract_revision.revision}`;
    if (outcomeContracts.has(outcomeContractKey)) add(errors, path, `Only one Outcome may adjudicate ${outcomeContractKey}`);
    outcomeContracts.add(outcomeContractKey);
    const acceptance = new Set(contract.acceptance_revisions.map((item) => item.acceptance_id));
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
      const contractReference = contract.acceptance_revisions.find((item) => item.acceptance_id === id);
      const criterion = ticket.acceptance.find((item) =>
        item.acceptance_id === contractReference?.acceptance_id
        && item.revision === contractReference?.revision);
      const exactSupportingEvidence = supportingEvidence.filter((supporting) => {
        const reference = evidenceBoundReferenceMap(supporting).get(id);
        return reference
          && reference.revision === contractReference?.revision
          && reference.identity === contractReference?.identity;
      });
      // Native closeout is born under the revision-aware contract, so every
      // support it selects must be exact. Reconstructed closeout preserves its
      // immutable legacy evidence_ids even when they include older supporting
      // material; those refs stay readable but do not become revision credit.
      if (document.binding_origin === "native") {
        for (const supporting of supportingEvidence) {
          if (!exactSupportingEvidence.includes(supporting)) {
            add(errors, path, `Referenced Evidence does not bind accepted revision: ${id}`);
          }
        }
      }
      if ((criterion?.authority ?? "agent") === "human"
        && !exactSupportingEvidence.some((item) => (item.origin ?? "agent") === "human")) {
        add(errors, path, `Human-authority criterion has no exact referenced human-origin Evidence: ${id}`);
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
  if (operation === "resolve") {
    assertCurrentProjectFormat(repo);
    if (typeof input.ref !== "string" || input.ref.trim() === "") {
      throw new VibeHubError("invalid_input", "context resolve needs a non-empty ref");
    }
    return resolveTicketContextRef(repo, input.ref);
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
  const outcome = currentOutcome(repository, ticket);
  if (outcome?.status === "successful") return "DONE";
  const blocking = ticket.relations
    .map((relation) => relation.target_ticket_id)
    .filter((id) => {
      const prerequisite = repository.tickets.documents.get(id)?.document;
      return !prerequisite || currentOutcome(repository, prerequisite)?.status !== "successful";
    });
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
  if (ticket.revision_state === "legacy-pending-reconstruction") {
    return {
      action: "WAIT",
      reason: "semantic_migration_pending",
      detail: "Legacy proof revision reconstruction must finish in this worktree before revision-bound Ticket work continues.",
      acceptance_ids: ticket.acceptance.map((criterion) => criterion.acceptance_id),
      blocking_ticket_ids: [],
    };
  }
  const currentAcceptance = activeAcceptance(ticket);
  const acceptanceIds = currentAcceptance.map((criterion) => criterion.acceptance_id);
  const activeReferences = activeAcceptanceReferenceMap(ticket);
  const outcome = currentOutcome(repository, ticket);
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
    .filter((id) => {
      const prerequisite = repository.tickets.documents.get(id)?.document;
      return !prerequisite || currentOutcome(repository, prerequisite)?.status !== "successful";
    })
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
    .filter((evidence) => evidence.ticket_id === ticket.ticket_id && evidence.binding_state === "bound");
  const coversActive = (evidence, acceptanceId) => {
    const expected = activeReferences.get(acceptanceId);
    const actual = evidenceBoundReferenceMap(evidence).get(acceptanceId);
    return expected && actual
      && expected.revision === actual.revision
      && expected.identity === actual.identity;
  };
  const evidencedIds = new Set(acceptanceIds.filter((acceptanceId) =>
    ticketEvidence.some((evidence) => coversActive(evidence, acceptanceId))));
  const humanEvidencedIds = new Set(ticketEvidence
    .filter((evidence) => evidenceOrigin(evidence) === "human")
    .flatMap((evidence) => evidence.acceptance_ids.filter((acceptanceId) => coversActive(evidence, acceptanceId))));
  const missingHumanIds = currentAcceptance
    .filter((criterion) => acceptanceAuthority(criterion) === "human"
      && !humanEvidencedIds.has(criterion.acceptance_id))
    .map((criterion) => criterion.acceptance_id);
  if (missingHumanIds.length > 0) {
    return {
      action: "NEEDS_HUMAN",
      reason: "missing_human_evidence",
      detail: "Reachable human-authority criteria still need explicit human-origin Evidence.",
      acceptance_ids: missingHumanIds,
      blocking_ticket_ids: [],
    };
  }

  const missingEvidenceIds = currentAcceptance
    .filter((criterion) => !evidencedIds.has(criterion.acceptance_id))
    .map((criterion) => criterion.acceptance_id);
  if (missingEvidenceIds.length === 0) {
    return {
      action: "CLOSE_OUT",
      reason: "authority_satisfying_evidence_complete",
      detail: "Every current criterion has authority-satisfying Evidence; independent adjudication is next.",
      acceptance_ids: acceptanceIds,
      blocking_ticket_ids: [],
    };
  }
  return {
    action: "EXECUTE",
    reason: "acceptance_evidence_incomplete",
    detail: "Executable criteria still need reproducible acceptance-linked Evidence.",
    acceptance_ids: missingEvidenceIds,
    blocking_ticket_ids: [],
  };
}

export function ticketArchived(repository, ticket) {
  if (!ticket) return false;
  const outcome = currentOutcome(repository, ticket);
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
      const targetOutcome = currentOutcome(candidateRepository, target);
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
          targetOutcome?.binding_state === "bound"
            ? `.vibehub/outcomes/${relation.target_ticket_id}/${targetOutcome.outcome_id}.yaml`
            : `.vibehub/outcomes/${relation.target_ticket_id}.yaml`,
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

function immutableAcceptanceRevision(item) {
  return {
    acceptance_id: item.acceptance_id,
    revision: item.revision,
    identity: item.identity,
    criterion: item.criterion,
    authority: item.authority ?? "agent",
    derived_from: item.derived_from ?? [],
  };
}

function validateTicketMutation(existing, candidate, path = "ticket") {
  const errors = [];
  if (!existing) return errors;
  if (existing.revision_state === "legacy-pending-reconstruction") {
    add(errors, path, "legacy-pending Ticket must finish project migrate-proof-revisions before ticket apply");
    return errors;
  }
  if (candidate.revision_state !== "bound") {
    add(errors, `${path}.revision_state`, "ordinary ticket apply cannot create a legacy migration state");
    return errors;
  }
  const candidateAcceptance = new Map(candidate.acceptance.map((item) => [acceptanceRevisionKey(item), item]));
  for (const prior of existing.acceptance) {
    const current = candidateAcceptance.get(acceptanceRevisionKey(prior));
    if (!current) {
      add(errors, `${path}.acceptance`, `cannot delete historical Acceptance revision ${acceptanceRevisionKey(prior)}`);
    } else if (JSON.stringify(stable(immutableAcceptanceRevision(current)))
      !== JSON.stringify(stable(immutableAcceptanceRevision(prior)))) {
      add(errors, `${path}.acceptance`, `cannot mutate immutable Acceptance revision ${acceptanceRevisionKey(prior)}; append a revision instead`);
    }
  }
  const priorContracts = new Map(existing.contract_revisions.map((item) => [item.revision, item]));
  const candidateContracts = new Map(candidate.contract_revisions.map((item) => [item.revision, item]));
  for (const [revision, prior] of priorContracts) {
    const current = candidateContracts.get(revision);
    if (!current) add(errors, `${path}.contract_revisions`, `cannot delete historical Contract revision v${revision}`);
    else if (JSON.stringify(stable(current)) !== JSON.stringify(stable(prior))) {
      add(errors, `${path}.contract_revisions`, `cannot mutate immutable Contract revision v${revision}; append a revision instead`);
    }
  }
  if (candidate.active_contract_revision < existing.active_contract_revision
    || candidate.active_contract_revision > existing.active_contract_revision + 1) {
    add(errors, `${path}.active_contract_revision`, "one ticket apply may retain the active Contract or append exactly its next revision");
  }
  const acceptanceGroups = new Map();
  for (const item of candidate.acceptance) {
    const items = acceptanceGroups.get(item.acceptance_id) ?? [];
    items.push(item);
    acceptanceGroups.set(item.acceptance_id, items);
  }
  for (const [acceptanceId, items] of acceptanceGroups) {
    const seenSemantics = new Set();
    for (const item of items) {
      const semantic = semanticDigest({
        acceptance_id: acceptanceId,
        criterion: item.criterion,
        authority: item.authority ?? "agent",
        derived_from: item.derived_from ?? [],
      });
      if (seenSemantics.has(semantic)) {
        add(errors, `${path}.acceptance`, `${acceptanceId} repeats identical contract semantics; presentation-only edits must not append a revision`);
      }
      seenSemantics.add(semantic);
    }
  }
  for (let index = 1; index < candidate.contract_revisions.length; index += 1) {
    if (contractMembershipKey(candidate.contract_revisions[index - 1].acceptance_revisions)
      === contractMembershipKey(candidate.contract_revisions[index].acceptance_revisions)) {
      add(errors, `${path}.contract_revisions[${index}]`, "must change exact Acceptance revision membership from the preceding Contract revision");
    }
  }
  return errors;
}

function ticketOperation(operation, repo, input, options = {}) {
  if (operation === "revise") {
    assertCurrentProjectFormat(repo);
    if (typeof input.ticket_id !== "string" || !ID.test(input.ticket_id)) {
      throw new VibeHubError("invalid_input", "ticket revise needs a valid ticket_id");
    }
    if (typeof input.validation !== "object" || input.validation === null
      || typeof input.validation.independent !== "boolean") {
      throw new VibeHubError("missing_validation_declaration", "ticket revise needs the same validation declaration as ticket apply");
    }
    const currentRepository = loadRepository(repo);
    assertValid(currentRepository.errors);
    const existing = currentRepository.tickets.documents.get(input.ticket_id)?.document;
    if (!existing) throw new VibeHubError("not_found", `Ticket not found: ${input.ticket_id}`);
    let candidate;
    try {
      candidate = appendTicketContractRevision(existing, input.mutation ?? {});
    } catch (error) {
      throw new VibeHubError("invalid_input", error instanceof Error ? error.message : String(error));
    }
    const validationRef = input.validation.independent ? "plan-validation:independent" : "plan-validation:none";
    candidate.provenance_refs = [
      ...(candidate.provenance_refs ?? []).filter((ref) => !String(ref).startsWith("plan-validation:")),
      validationRef,
    ];
    const errors = [
      ...validateTicket(candidate, "ticket"),
      ...validateTicketMutation(existing, candidate, "ticket"),
    ];
    assertValid(errors, "Ticket revision is invalid");
    const repository = loadRepository(repo, { tickets: [candidate] });
    assertValid(repository.errors);
    const path = join(repository.paths.tickets, `${candidate.ticket_id}.yaml`);
    writeDocument(path, candidate);
    return {
      status: "written",
      ticket_id: candidate.ticket_id,
      active_contract_revision: candidate.active_contract_revision,
      path,
    };
  }
  if (operation === "apply") {
    assertCurrentProjectFormat(repo);
    if (!Array.isArray(input.tickets) || input.tickets.length === 0) {
      throw new VibeHubError("invalid_input", "ticket apply needs a non-empty tickets array");
    }
    // The plan Skill asks a separate Agent to validate a candidate "when an
    // independent Agent is available". Left implicit, an unavailable one is
    // indistinguishable from an unasked one. The declaration is required so a
    // skip is recorded rather than merely undetected; like the closeout
    // declaration, the engine records the claim and never verifies it.
    if (typeof input.validation !== "object" || input.validation === null
      || typeof input.validation.independent !== "boolean") {
      throw new VibeHubError(
        "missing_validation_declaration",
        'ticket apply needs a validation declaration: {"validation":{"independent":true|false,"note":"..."}}. State whether a separate Agent validated this candidate; an unrecorded skip is not permitted.',
      );
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
    for (const [index, ticket] of input.tickets.entries()) {
      const existing = currentRepository.tickets.documents.get(ticket.ticket_id)?.document;
      errors.push(...validateTicketMutation(existing, ticket, `tickets[${index}]`));
    }
    assertValid(errors, "Ticket candidate violates append-only revision history");
    const repository = loadRepository(repo, { tickets: input.tickets });
    assertValid(repository.errors);
    const advice = candidateDependencyAdvice(currentRepository, repository, input.tickets);
    // Namespaced deliberately: bare `validation:` is already used in checked-in
    // Tickets to name the Ticket or decision that validated a claim, and
    // rewriting that would erase history on every re-apply.
    const validationRef = input.validation.independent ? "plan-validation:independent" : "plan-validation:none";
    const written = [];
    for (const ticket of input.tickets) {
      const path = join(repository.paths.tickets, `${ticket.ticket_id}.yaml`);
      const provenance = (ticket.provenance_refs ?? []).filter((ref) => !String(ref).startsWith("plan-validation:"));
      const recorded = { ...ticket, provenance_refs: [...provenance, validationRef] };
      assertValid(validateTicket(recorded, `tickets[${ticket.ticket_id}]`), "Ticket candidate is invalid");
      writeDocument(path, recorded);
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
    if (input.binding_state !== "bound" || input.binding_origin !== "native") {
      throw new VibeHubError("invalid_input", "ordinary ticket evidence must be a native exact revision binding");
    }
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
    if (input.independence === undefined) {
      throw new VibeHubError(
        "missing_independence",
        `ticket closeout needs an independence declaration: {"independence":{"source":"<${[...INDEPENDENCE_SOURCES].join("|")}>","note":"..."}}. The closeout Agent must be independent from the executor; if no independent source is available, stop and report that rather than adjudicating your own work.`,
      );
    }
    if (input.binding_state !== "bound" || input.binding_origin !== "native") {
      throw new VibeHubError("invalid_input", "ordinary ticket closeout must be a native exact Contract revision binding");
    }
    const errors = validateOutcome(input);
    assertValid(errors, "Outcome document is invalid");
    const currentRepository = loadRepository(repo);
    assertValid(currentRepository.errors);
    if (currentRepository.outcomes.history.has(`${input.ticket_id}:${input.outcome_id}`)) {
      throw new VibeHubError("invalid_state", `Outcome already exists for ${input.ticket_id} ${input.outcome_id}`);
    }
    const repository = loadRepository(repo, { outcomes: [input] });
    assertValid(repository.errors);
    const path = join(repository.paths.outcomes, input.ticket_id, `${input.outcome_id}.yaml`);
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
      outcome_count: outcomeDocuments(repository).length,
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
      outcome: currentOutcome(repository, item),
      outcome_history: outcomesForTicket(repository, input.ticket_id),
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
        .filter((id) => {
          const prerequisite = repository.tickets.documents.get(id)?.document;
          return !prerequisite || currentOutcome(repository, prerequisite)?.status !== "successful";
        }),
      outcome: currentOutcome(repository, ticket),
      outcome_history: outcomesForTicket(repository, ticket.ticket_id),
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

function git(repo, args, { allowFailure = false, binary = false } = {}) {
  // Every caller accepts repository paths. Disable repository-configured
  // fsmonitor hooks so validation, resolution, and drift reads stay inert.
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", repo, ...args], {
    ...(binary ? {} : { encoding: "utf8" }),
    maxBuffer: 64 * 1024 * 1024,
  });
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

function roomOperation(operation, repo, input, options = {}) {
  if (operation === "align" || operation === "stale") {
    assertCurrentProjectFormat(repo);
  }
  const repository = loadRepository(repo);
  assertValid(repository.errors);
  if (operation === "drift") {
    return projectRoomDrift(repo, repository);
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
  if (operation === "migrate-mechanical") return migrateMechanical(repo);
  if (operation === "migrate-proof-revisions") return migrateProofRevisions(repo);
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
      outcomes: outcomeDocuments(repository).length,
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
