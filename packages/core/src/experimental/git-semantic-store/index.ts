/**
 * Architecture spike only. SQLite remains canonical.
 *
 * This module deliberately has no package-root export and no runtime/App/MCP
 * wiring. Export opens an explicit database path through the read-only door;
 * import refuses to touch an existing database and reconstructs only the
 * durable semantic subset in a fresh SQLite file.
 *
 * The on-disk protocol is canonical JSON, which is a strict YAML 1.2 subset.
 * Requiring byte-for-byte canonical input rejects YAML aliases, tags, merge
 * keys, duplicate keys, alternate scalar spellings, and unknown whitespace.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { openDb, withReadonlyDb, type Db } from "../../db.js";

const FORMAT = "vibehub.git-semantic-store";
const SCHEMA_VERSION = 1;
const STORE_RELATIVE_PATH = path.join(".vibehub", "semantic-store", "v1");
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SPEC_TYPES = new Set(["intent", "decision", "constraint", "convention", "contract", "context", "change"]);
const SPEC_STATES = new Set(["draft", "active", "stale", "superseded", "deprecated"]);
const RELATION_TYPES = new Set(["depends_on", "relates_to", "supersedes", "conflicts_with"]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RecordValue = Record<string, unknown>;

interface FeatureDocument {
  schema_version: 1;
  kind: "feature";
  feature_id: string;
  created_at: string;
}

interface AnchorDocument {
  file: string;
  symbol: string;
  line_start: number | null;
  line_end: number | null;
  content_hash: string | null;
}

interface EvidenceDocument {
  evidence_id: string;
  source_type: string;
  source_ref: string;
  exact_quote: string | null;
  evidence_ref: string | null;
  content_hash: string | null;
  confidence: number | null;
  producer: string;
  produced_at: string;
}

interface RevisionDocument {
  revision: number;
  type: string;
  summary: string;
  detail: string | null;
  priority: string | null;
  layer: string | null;
  domain: string | null;
  tags: string[];
  producer: string;
  produced_at: string;
  evidence: EvidenceDocument[];
  anchors: AnchorDocument[];
}

interface RelationDocument {
  to_spec_id: string;
  type: string;
  rationale: string | null;
  created_at: string;
}

interface ProvenanceDocument {
  event_id: number;
  operation: string;
  actor: string;
  task_id: string | null;
  request_id: string;
  at: string;
  payload: JsonValue;
}

interface SpecDocument {
  schema_version: 1;
  kind: "spec";
  spec_id: string;
  feature_id: string | null;
  state: string;
  current_revision: number;
  source_kind: "canonical";
  created_at: string;
  updated_at: string;
  revisions: RevisionDocument[];
  relations: RelationDocument[];
  provenance: ProvenanceDocument[];
}

interface ManifestEntry {
  id: string;
  file: string;
  sha256: string;
}

interface ManifestDocument {
  schema_version: 1;
  format: typeof FORMAT;
  repository: {
    slug: string | null;
    default_branch: string;
    created_at: string;
  };
  features: ManifestEntry[];
  specs: ManifestEntry[];
  repo_provenance: ProvenanceDocument[];
  semantic_digest: string;
}

export interface ExportGitSemanticStoreOptions {
  /** Explicit SQLite path. The source is opened only through withReadonlyDb. */
  dbPath: string;
  repoId: number;
  worktreeRoot: string;
}

export interface ImportGitSemanticStoreOptions {
  worktreeRoot: string;
  /** Must not exist. Import never migrates, truncates, or overwrites a DB. */
  targetDbPath: string;
  /** Machine-local identity is supplied at import and never committed to Git. */
  targetRepoRootPath: string;
}

export interface GitSemanticStoreResult {
  storePath: string;
  semanticDigest: string;
  featureCount: number;
  specCount: number;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("git semantic store: non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  throw new Error(`git semantic store: unsupported canonical value ${typeof value}`);
};

const serialize = (value: unknown): string =>
  `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const parseStoredJson = (raw: string, field: string): JsonValue => {
  try {
    return canonicalize(JSON.parse(raw));
  } catch {
    throw new Error(`git semantic store: invalid JSON in SQLite field ${field}`);
  }
};

const storePathFor = (worktreeRoot: string): string =>
  path.join(path.resolve(worktreeRoot), STORE_RELATIVE_PATH);

const semanticDigest = (
  features: ManifestEntry[],
  specs: ManifestEntry[],
  repoProvenance: ProvenanceDocument[],
): string => sha256(serialize({
  features: features.map(({ id, sha256: digest }) => ({ id, sha256: digest })),
  specs: specs.map(({ id, sha256: digest }) => ({ id, sha256: digest })),
  repo_provenance: repoProvenance,
}));

const readFeatureDocuments = (db: Db, repoId: number): FeatureDocument[] =>
  (db.prepare(`SELECT feature_id, created_at FROM kb_features
    WHERE repo_id = ? ORDER BY feature_id`).all(repoId) as Array<{
      feature_id: string;
      created_at: string;
    }>).map((row) => ({
      schema_version: SCHEMA_VERSION,
      kind: "feature",
      ...row,
    }));

const readProvenance = (
  db: Db,
  repoId: number,
  specId: string | null,
): ProvenanceDocument[] => {
  const clause = specId === null ? "spec_id IS NULL" : "spec_id = ?";
  const params = specId === null ? [repoId] : [repoId, specId];
  return (db.prepare(`SELECT id AS event_id, operation, actor, task_id, request_id, at, payload
    FROM kb_provenance_events WHERE repo_id = ? AND ${clause} ORDER BY id`).all(...params) as
    Array<Omit<ProvenanceDocument, "payload"> & { payload: string }>)
    .map((row) => ({ ...row, payload: parseStoredJson(row.payload, "kb_provenance_events.payload") }));
};

const readSpecDocuments = (db: Db, repoId: number): SpecDocument[] => {
  const specs = db.prepare(`SELECT spec_id, feature_id, state, current_revision, source_kind,
    created_at, updated_at FROM kb_specs WHERE repo_id = ? ORDER BY spec_id`).all(repoId) as
    Array<Omit<SpecDocument, "schema_version" | "kind" | "revisions" | "relations" | "provenance">>;
  const revisionsStatement = db.prepare(`SELECT revision, type, summary, detail, priority, layer,
    domain, tags, producer, produced_at FROM kb_spec_revisions
    WHERE repo_id = ? AND spec_id = ? ORDER BY revision`);
  const evidenceStatement = db.prepare(`SELECT evidence_id, source_type, source_ref, exact_quote,
    evidence_ref, content_hash, confidence, producer, produced_at FROM kb_evidence
    WHERE repo_id = ? AND spec_id = ? AND revision = ? ORDER BY evidence_id`);
  const anchorsStatement = db.prepare(`SELECT file, symbol, line_start, line_end, content_hash
    FROM kb_spec_revision_anchors WHERE repo_id = ? AND spec_id = ? AND revision = ?
    ORDER BY file, symbol`);
  const relationsStatement = db.prepare(`SELECT to_spec_id, type, rationale, created_at
    FROM kb_spec_relations WHERE repo_id = ? AND from_spec_id = ?
    ORDER BY type, to_spec_id`);

  return specs.map((spec) => {
    if (spec.source_kind !== "canonical") {
      throw new Error(`git semantic store: unsupported source_kind for ${spec.spec_id}`);
    }
    const revisions = (revisionsStatement.all(repoId, spec.spec_id) as
      Array<Omit<RevisionDocument, "tags" | "evidence" | "anchors"> & { tags: string }>)
      .map((revision) => ({
        ...revision,
        tags: (() => {
          const value = parseStoredJson(revision.tags, "kb_spec_revisions.tags");
          if (!Array.isArray(value)) throw new Error("git semantic store: revision tags must be an array");
          return value.map((tag, index) =>
            stringValue(tag, `kb_spec_revisions.tags[${index}]`));
        })(),
        evidence: evidenceStatement.all(repoId, spec.spec_id, revision.revision) as EvidenceDocument[],
        anchors: anchorsStatement.all(repoId, spec.spec_id, revision.revision) as AnchorDocument[],
      }));
    if (!revisions.some((revision) => revision.revision === spec.current_revision)) {
      throw new Error(`git semantic store: ${spec.spec_id} current revision is missing`);
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "spec",
      ...spec,
      source_kind: "canonical",
      revisions,
      relations: relationsStatement.all(repoId, spec.spec_id) as RelationDocument[],
      provenance: readProvenance(db, repoId, spec.spec_id),
    };
  });
};

const writeDocument = (
  directory: string,
  document: FeatureDocument | SpecDocument,
): ManifestEntry => {
  const bytes = serialize(document);
  const digest = sha256(bytes);
  const file = `sha256-${digest}.yaml`;
  fs.writeFileSync(path.join(directory, file), bytes, { encoding: "utf8", flag: "wx" });
  return {
    id: document.kind === "feature" ? document.feature_id : document.spec_id,
    file: `${document.kind === "feature" ? "features" : "specs"}/${file}`,
    sha256: digest,
  };
};

export function exportGitSemanticStore(
  options: ExportGitSemanticStoreOptions,
): GitSemanticStoreResult {
  const finalStorePath = storePathFor(options.worktreeRoot);
  if (fs.existsSync(finalStorePath)) {
    throw new Error(`git semantic store: destination already exists: ${finalStorePath}`);
  }

  return withReadonlyDb(options.dbPath, (db) => {
    const repo = db.prepare(`SELECT slug, default_branch, created_at FROM repos WHERE id = ?`)
      .get(options.repoId) as ManifestDocument["repository"] | undefined;
    if (!repo) throw new Error(`git semantic store: repository not found: ${options.repoId}`);

    const featureDocuments = readFeatureDocuments(db, options.repoId);
    const specDocuments = readSpecDocuments(db, options.repoId);
    for (const document of featureDocuments) validateFeature(document, document.feature_id);
    for (const document of specDocuments) validateSpec(document, document.spec_id);
    const knownSpecs = new Set(specDocuments.map((spec) => spec.spec_id));
    for (const spec of specDocuments) {
      for (const relation of spec.relations) {
        if (!knownSpecs.has(relation.to_spec_id)) {
          throw new Error(`git semantic store: relation target is outside export closure: ${relation.to_spec_id}`);
        }
      }
    }
    const orphanProvenance = db.prepare(`SELECT id, spec_id FROM kb_provenance_events
      WHERE repo_id = ? AND spec_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM kb_specs s
        WHERE s.repo_id = kb_provenance_events.repo_id
        AND s.spec_id = kb_provenance_events.spec_id) LIMIT 1`).get(options.repoId);
    if (orphanProvenance) throw new Error("git semantic store: provenance references a missing spec");

    const parent = path.dirname(finalStorePath);
    fs.mkdirSync(parent, { recursive: true });
    const stagingRoot = fs.mkdtempSync(path.join(parent, ".v1-export-"));
    const stagingStore = path.join(stagingRoot, "v1");
    try {
      const featureDirectory = path.join(stagingStore, "features");
      const specDirectory = path.join(stagingStore, "specs");
      fs.mkdirSync(featureDirectory, { recursive: true });
      fs.mkdirSync(specDirectory, { recursive: true });
      const features = featureDocuments.map((document) => writeDocument(featureDirectory, document));
      const specs = specDocuments.map((document) => writeDocument(specDirectory, document));
      const repoProvenance = readProvenance(db, options.repoId, null);
      const digest = semanticDigest(features, specs, repoProvenance);
      const manifest: ManifestDocument = {
        schema_version: SCHEMA_VERSION,
        format: FORMAT,
        repository: repo,
        features,
        specs,
        repo_provenance: repoProvenance,
        semantic_digest: digest,
      };
      fs.writeFileSync(path.join(stagingStore, "manifest.yaml"), serialize(manifest), {
        encoding: "utf8",
        flag: "wx",
      });
      fs.renameSync(stagingStore, finalStorePath);
      return {
        storePath: finalStorePath,
        semanticDigest: digest,
        featureCount: features.length,
        specCount: specs.length,
      };
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}

const exactKeys = (value: unknown, keys: readonly string[], field: string): RecordValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`git semantic store: ${field} must be an object`);
  }
  const record = value as RecordValue;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`git semantic store: ${field} has unknown or missing fields`);
  }
  return record;
};

const stringValue = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`git semantic store: ${field} must be a string`);
  return value;
};

const nullableString = (value: unknown, field: string): string | null =>
  value === null ? null : stringValue(value, field);

const canonicalIdentity = (value: unknown, field: string): string => {
  const result = stringValue(value, field);
  if (result === "" || result !== result.trim()) {
    throw new Error(`git semantic store: ${field} must be a canonical nonblank string`);
  }
  return result;
};

const positiveInteger = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`git semantic store: ${field} must be a positive integer`);
  }
  return value as number;
};

const nullableNumber = (value: unknown, field: string): number | null => {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`git semantic store: ${field} must be a finite number or null`);
  }
  return value;
};

const arrayValue = (value: unknown, field: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`git semantic store: ${field} must be an array`);
  return value;
};

const assertSortedUnique = <T>(
  values: T[],
  key: (value: T) => string | number,
  field: string,
): void => {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && key(values[index - 1]!) >= key(values[index]!)) {
      throw new Error(`git semantic store: ${field} must be strictly sorted and unique`);
    }
  }
};

const readCanonicalDocument = (filePath: string, expectedDigest?: string): unknown => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`git semantic store: document must be a regular file: ${filePath}`);
  }
  const bytes = fs.readFileSync(filePath, "utf8");
  if (expectedDigest !== undefined && sha256(bytes) !== expectedDigest) {
    throw new Error(`git semantic store: digest mismatch: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`git semantic store: document is not canonical JSON/YAML 1.2: ${filePath}`);
  }
  if (serialize(parsed) !== bytes) {
    throw new Error(`git semantic store: non-canonical or duplicate-key document: ${filePath}`);
  }
  return parsed;
};

const validateProvenance = (value: unknown, field: string): ProvenanceDocument => {
  const row = exactKeys(value, [
    "event_id", "operation", "actor", "task_id", "request_id", "at", "payload",
  ], field);
  return {
    event_id: positiveInteger(row.event_id, `${field}.event_id`),
    operation: stringValue(row.operation, `${field}.operation`),
    actor: stringValue(row.actor, `${field}.actor`),
    task_id: nullableString(row.task_id, `${field}.task_id`),
    request_id: stringValue(row.request_id, `${field}.request_id`),
    at: stringValue(row.at, `${field}.at`),
    payload: canonicalize(row.payload),
  };
};

const validateEntry = (value: unknown, kind: "features" | "specs", index: number): ManifestEntry => {
  const field = `manifest.${kind}[${index}]`;
  const row = exactKeys(value, ["id", "file", "sha256"], field);
  const id = canonicalIdentity(row.id, `${field}.id`);
  const digest = stringValue(row.sha256, `${field}.sha256`);
  const file = stringValue(row.file, `${field}.file`);
  const expectedFile = `${kind}/sha256-${digest}.yaml`;
  if (!HASH_PATTERN.test(digest) || file !== expectedFile) {
    throw new Error(`git semantic store: invalid content-addressed path in ${field}`);
  }
  return { id, file, sha256: digest };
};

const validateManifest = (value: unknown): ManifestDocument => {
  const row = exactKeys(value, [
    "schema_version", "format", "repository", "features", "specs",
    "repo_provenance", "semantic_digest",
  ], "manifest");
  if (row.schema_version !== SCHEMA_VERSION || row.format !== FORMAT) {
    throw new Error("git semantic store: unsupported manifest protocol");
  }
  const repository = exactKeys(row.repository, ["slug", "default_branch", "created_at"], "manifest.repository");
  const features = arrayValue(row.features, "manifest.features")
    .map((entry, index) => validateEntry(entry, "features", index));
  const specs = arrayValue(row.specs, "manifest.specs")
    .map((entry, index) => validateEntry(entry, "specs", index));
  const repoProvenance = arrayValue(row.repo_provenance, "manifest.repo_provenance")
    .map((entry, index) => validateProvenance(entry, `manifest.repo_provenance[${index}]`));
  const digest = stringValue(row.semantic_digest, "manifest.semantic_digest");
  if (!HASH_PATTERN.test(digest) || digest !== semanticDigest(features, specs, repoProvenance)) {
    throw new Error("git semantic store: semantic digest mismatch");
  }
  for (const entries of [features, specs]) {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length ||
        new Set(entries.map((entry) => entry.file)).size !== entries.length) {
      throw new Error("git semantic store: duplicate manifest identity or file");
    }
  }
  assertSortedUnique(features, (entry) => entry.id, "manifest.features");
  assertSortedUnique(specs, (entry) => entry.id, "manifest.specs");
  assertSortedUnique(repoProvenance, (entry) => entry.event_id, "manifest.repo_provenance");
  return {
    schema_version: SCHEMA_VERSION,
    format: FORMAT,
    repository: {
      slug: nullableString(repository.slug, "manifest.repository.slug"),
      default_branch: canonicalIdentity(repository.default_branch, "manifest.repository.default_branch"),
      created_at: stringValue(repository.created_at, "manifest.repository.created_at"),
    },
    features,
    specs,
    repo_provenance: repoProvenance,
    semantic_digest: digest,
  };
};

const validateFeature = (value: unknown, expectedId: string): FeatureDocument => {
  const row = exactKeys(value, ["schema_version", "kind", "feature_id", "created_at"], `feature ${expectedId}`);
  if (row.schema_version !== SCHEMA_VERSION || row.kind !== "feature" || row.feature_id !== expectedId) {
    throw new Error(`git semantic store: feature identity/protocol mismatch: ${expectedId}`);
  }
  return {
    schema_version: SCHEMA_VERSION,
    kind: "feature",
    feature_id: canonicalIdentity(expectedId, `feature ${expectedId}.feature_id`),
    created_at: stringValue(row.created_at, `feature ${expectedId}.created_at`),
  };
};

const validateAnchor = (value: unknown, field: string): AnchorDocument => {
  const row = exactKeys(value, ["file", "symbol", "line_start", "line_end", "content_hash"], field);
  const lineStart = row.line_start === null ? null : positiveInteger(row.line_start, `${field}.line_start`);
  const lineEnd = row.line_end === null ? null : positiveInteger(row.line_end, `${field}.line_end`);
  if (lineEnd !== null && (lineStart === null || lineEnd < lineStart)) {
    throw new Error(`git semantic store: invalid line range in ${field}`);
  }
  const file = stringValue(row.file, `${field}.file`);
  if (file.includes("\\") || file.startsWith("/") ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`git semantic store: ${field}.file must be a canonical repo-relative path`);
  }
  return {
    file,
    symbol: stringValue(row.symbol, `${field}.symbol`),
    line_start: lineStart,
    line_end: lineEnd,
    content_hash: nullableString(row.content_hash, `${field}.content_hash`),
  };
};

const validateEvidence = (value: unknown, field: string): EvidenceDocument => {
  const row = exactKeys(value, [
    "evidence_id", "source_type", "source_ref", "exact_quote", "evidence_ref",
    "content_hash", "confidence", "producer", "produced_at",
  ], field);
  const evidence: EvidenceDocument = {
    evidence_id: canonicalIdentity(row.evidence_id, `${field}.evidence_id`),
    source_type: stringValue(row.source_type, `${field}.source_type`),
    source_ref: stringValue(row.source_ref, `${field}.source_ref`),
    exact_quote: nullableString(row.exact_quote, `${field}.exact_quote`),
    evidence_ref: nullableString(row.evidence_ref, `${field}.evidence_ref`),
    content_hash: nullableString(row.content_hash, `${field}.content_hash`),
    confidence: nullableNumber(row.confidence, `${field}.confidence`),
    producer: stringValue(row.producer, `${field}.producer`),
    produced_at: stringValue(row.produced_at, `${field}.produced_at`),
  };
  if (evidence.exact_quote === null && evidence.evidence_ref === null && evidence.content_hash === null) {
    throw new Error(`git semantic store: evidence has no durable reference in ${field}`);
  }
  if (evidence.confidence !== null && (evidence.confidence < 0 || evidence.confidence > 1)) {
    throw new Error(`git semantic store: confidence is out of range in ${field}`);
  }
  return evidence;
};

const validateRevision = (value: unknown, field: string): RevisionDocument => {
  const row = exactKeys(value, [
    "revision", "type", "summary", "detail", "priority", "layer", "domain",
    "tags", "producer", "produced_at", "evidence", "anchors",
  ], field);
  const evidence = arrayValue(row.evidence, `${field}.evidence`)
    .map((item, index) => validateEvidence(item, `${field}.evidence[${index}]`));
  const anchors = arrayValue(row.anchors, `${field}.anchors`)
    .map((item, index) => validateAnchor(item, `${field}.anchors[${index}]`));
  assertSortedUnique(evidence, (item) => item.evidence_id, `${field}.evidence`);
  assertSortedUnique(anchors, (item) => `${item.file}\0${item.symbol}`, `${field}.anchors`);
  const type = stringValue(row.type, `${field}.type`);
  if (!SPEC_TYPES.has(type)) throw new Error(`git semantic store: invalid spec type in ${field}`);
  return {
    revision: positiveInteger(row.revision, `${field}.revision`),
    type,
    summary: stringValue(row.summary, `${field}.summary`),
    detail: nullableString(row.detail, `${field}.detail`),
    priority: nullableString(row.priority, `${field}.priority`),
    layer: nullableString(row.layer, `${field}.layer`),
    domain: nullableString(row.domain, `${field}.domain`),
    tags: arrayValue(row.tags, `${field}.tags`)
      .map((tag, index) => stringValue(tag, `${field}.tags[${index}]`)),
    producer: stringValue(row.producer, `${field}.producer`),
    produced_at: stringValue(row.produced_at, `${field}.produced_at`),
    evidence,
    anchors,
  };
};

const validateSpec = (value: unknown, expectedId: string): SpecDocument => {
  const field = `spec ${expectedId}`;
  const row = exactKeys(value, [
    "schema_version", "kind", "spec_id", "feature_id", "state", "current_revision",
    "source_kind", "created_at", "updated_at", "revisions", "relations", "provenance",
  ], field);
  if (row.schema_version !== SCHEMA_VERSION || row.kind !== "spec" ||
      row.spec_id !== expectedId || row.source_kind !== "canonical") {
    throw new Error(`git semantic store: spec identity/protocol mismatch: ${expectedId}`);
  }
  const revisions = arrayValue(row.revisions, `${field}.revisions`)
    .map((item, index) => validateRevision(item, `${field}.revisions[${index}]`));
  assertSortedUnique(revisions, (revision) => revision.revision, `${field}.revisions`);
  const currentRevision = positiveInteger(row.current_revision, `${field}.current_revision`);
  if (!revisions.some((revision) => revision.revision === currentRevision) ||
      new Set(revisions.map((revision) => revision.revision)).size !== revisions.length) {
    throw new Error(`git semantic store: invalid revision set for ${expectedId}`);
  }
  const relations = arrayValue(row.relations, `${field}.relations`).map((item, index) => {
    const relationField = `${field}.relations[${index}]`;
    const relation = exactKeys(item, ["to_spec_id", "type", "rationale", "created_at"], relationField);
    const type = stringValue(relation.type, `${relationField}.type`);
    if (!RELATION_TYPES.has(type)) {
      throw new Error(`git semantic store: invalid relation type in ${relationField}`);
    }
    return {
      to_spec_id: canonicalIdentity(relation.to_spec_id, `${relationField}.to_spec_id`),
      type,
      rationale: nullableString(relation.rationale, `${relationField}.rationale`),
      created_at: stringValue(relation.created_at, `${relationField}.created_at`),
    };
  });
  assertSortedUnique(
    relations,
    (relation) => `${relation.type}\0${relation.to_spec_id}`,
    `${field}.relations`,
  );
  const provenance = arrayValue(row.provenance, `${field}.provenance`)
    .map((item, index) => validateProvenance(item, `${field}.provenance[${index}]`));
  assertSortedUnique(provenance, (event) => event.event_id, `${field}.provenance`);
  return {
    schema_version: SCHEMA_VERSION,
    kind: "spec",
    spec_id: canonicalIdentity(expectedId, `${field}.spec_id`),
    feature_id: row.feature_id === null
      ? null
      : canonicalIdentity(row.feature_id, `${field}.feature_id`),
    state: (() => {
      const state = stringValue(row.state, `${field}.state`);
      if (!SPEC_STATES.has(state)) throw new Error(`git semantic store: invalid state in ${field}`);
      return state;
    })(),
    current_revision: currentRevision,
    source_kind: "canonical",
    created_at: stringValue(row.created_at, `${field}.created_at`),
    updated_at: stringValue(row.updated_at, `${field}.updated_at`),
    revisions,
    relations,
    provenance,
  };
};

const safeDocumentPath = (storePath: string, relative: string): string => {
  const resolved = path.resolve(storePath, relative);
  if (!resolved.startsWith(`${path.resolve(storePath)}${path.sep}`)) {
    throw new Error("git semantic store: manifest path escapes store");
  }
  return resolved;
};

const assertExactInventory = (storePath: string, manifest: ManifestDocument): void => {
  for (const directory of [storePath, path.join(storePath, "features"), path.join(storePath, "specs")]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`git semantic store: protocol directory is invalid: ${directory}`);
    }
  }
  const expected = new Set([
    "manifest.yaml",
    ...manifest.features.map((entry) => entry.file),
    ...manifest.specs.map((entry) => entry.file),
  ]);
  const found = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`git semantic store: symlinks are forbidden: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.add(path.relative(storePath, absolute));
      else throw new Error(`git semantic store: non-regular store entry: ${absolute}`);
    }
  };
  visit(storePath);
  if (found.size !== expected.size || [...found].some((file) => !expected.has(file))) {
    throw new Error("git semantic store: store inventory does not match manifest");
  }
};

const insertProvenance = (
  db: Db,
  repoId: number,
  specId: string | null,
  rows: ProvenanceDocument[],
): void => {
  const insert = db.prepare(`INSERT INTO kb_provenance_events
    (id, repo_id, operation, spec_id, actor, task_id, request_id, at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) {
    insert.run(
      row.event_id, repoId, row.operation, specId, row.actor, row.task_id,
      row.request_id, row.at, serialize(row.payload).trimEnd(),
    );
  }
};

const populateDatabase = (
  db: Db,
  manifest: ManifestDocument,
  features: FeatureDocument[],
  specs: SpecDocument[],
  rootPath: string,
): number => db.transaction(() => {
  const repoResult = db.prepare(`INSERT INTO repos (root_path, slug, default_branch, created_at)
    VALUES (?, ?, ?, ?)`).run(
    path.resolve(rootPath),
    manifest.repository.slug,
    manifest.repository.default_branch,
    manifest.repository.created_at,
  );
  const repoId = Number(repoResult.lastInsertRowid);
  const insertFeature = db.prepare(`INSERT INTO kb_features (repo_id, feature_id, created_at)
    VALUES (?, ?, ?)`);
  for (const feature of features) insertFeature.run(repoId, feature.feature_id, feature.created_at);

  const insertSpec = db.prepare(`INSERT INTO kb_specs
    (repo_id, spec_id, feature_id, state, current_revision, source_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'canonical', ?, ?)`);
  const insertRevision = db.prepare(`INSERT INTO kb_spec_revisions
    (repo_id, spec_id, revision, type, summary, detail, priority, layer, domain, tags, producer, produced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEvidence = db.prepare(`INSERT INTO kb_evidence
    (repo_id, evidence_id, spec_id, revision, source_type, source_ref, exact_quote,
      evidence_ref, content_hash, confidence, producer, produced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertAnchor = db.prepare(`INSERT INTO kb_spec_revision_anchors
    (repo_id, spec_id, revision, file, symbol, line_start, line_end, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const spec of specs) {
    insertSpec.run(
      repoId, spec.spec_id, spec.feature_id, spec.state, spec.current_revision,
      spec.created_at, spec.updated_at,
    );
    for (const revision of spec.revisions) {
      insertRevision.run(
        repoId, spec.spec_id, revision.revision, revision.type, revision.summary,
        revision.detail, revision.priority, revision.layer, revision.domain,
        serialize(revision.tags).trimEnd(), revision.producer, revision.produced_at,
      );
      for (const evidence of revision.evidence) {
        insertEvidence.run(
          repoId, evidence.evidence_id, spec.spec_id, revision.revision,
          evidence.source_type, evidence.source_ref, evidence.exact_quote,
          evidence.evidence_ref, evidence.content_hash, evidence.confidence,
          evidence.producer, evidence.produced_at,
        );
      }
      for (const anchor of revision.anchors) {
        insertAnchor.run(
          repoId, spec.spec_id, revision.revision, anchor.file, anchor.symbol,
          anchor.line_start, anchor.line_end, anchor.content_hash,
        );
      }
    }
  }

  const knownSpecs = new Set(specs.map((spec) => spec.spec_id));
  const insertRelation = db.prepare(`INSERT INTO kb_spec_relations
    (repo_id, from_spec_id, to_spec_id, type, rationale, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const spec of specs) {
    for (const relation of spec.relations) {
      if (!knownSpecs.has(relation.to_spec_id)) {
        throw new Error(`git semantic store: relation target is missing: ${relation.to_spec_id}`);
      }
      insertRelation.run(
        repoId, spec.spec_id, relation.to_spec_id, relation.type,
        relation.rationale, relation.created_at,
      );
    }
  }
  db.prepare(`INSERT INTO kb_spec_current_anchors
    SELECT a.repo_id, a.spec_id, a.revision, a.file, a.symbol,
      a.line_start, a.line_end, a.content_hash
    FROM kb_spec_revision_anchors a
    JOIN kb_specs s ON s.repo_id = a.repo_id AND s.spec_id = a.spec_id
      AND s.current_revision = a.revision
    WHERE a.repo_id = ?`).run(repoId);
  insertProvenance(db, repoId, null, manifest.repo_provenance);
  for (const spec of specs) insertProvenance(db, repoId, spec.spec_id, spec.provenance);
  return repoId;
})();

export function importGitSemanticStore(
  options: ImportGitSemanticStoreOptions,
): GitSemanticStoreResult & { repoId: number; dbPath: string } {
  const target = path.resolve(options.targetDbPath);
  if (fs.existsSync(target) || fs.existsSync(`${target}-wal`) || fs.existsSync(`${target}-shm`)) {
    throw new Error(`git semantic store: target database already exists: ${target}`);
  }
  const storePath = storePathFor(options.worktreeRoot);
  const manifest = validateManifest(readCanonicalDocument(path.join(storePath, "manifest.yaml")));
  assertExactInventory(storePath, manifest);
  const features = manifest.features.map((entry) =>
    validateFeature(readCanonicalDocument(
      safeDocumentPath(storePath, entry.file),
      entry.sha256,
    ), entry.id));
  const specs = manifest.specs.map((entry) =>
    validateSpec(readCanonicalDocument(
      safeDocumentPath(storePath, entry.file),
      entry.sha256,
    ), entry.id));

  const targetParent = path.dirname(target);
  fs.mkdirSync(targetParent, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(path.join(targetParent, ".git-semantic-import-"));
  const stagingDb = path.join(stagingDirectory, "semantic.db");
  let db: Db | null = null;
  try {
    db = openDb(stagingDb);
    const repoId = populateDatabase(
      db,
      manifest,
      features,
      specs,
      options.targetRepoRootPath,
    );
    const foreignKeyErrors = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyErrors.length > 0) throw new Error("git semantic store: imported foreign key violation");
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    db = null;
    fs.copyFileSync(stagingDb, target, fs.constants.COPYFILE_EXCL);
    return {
      storePath,
      dbPath: target,
      repoId,
      semanticDigest: manifest.semantic_digest,
      featureCount: features.length,
      specCount: specs.length,
    };
  } finally {
    if (db?.open) db.close();
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
  }
}
