/**
 * Git semantic store.
 *
 * Git carries durable semantic truth. SQLite databases created here are
 * disposable, commit/worktree-scoped query caches.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  exportGitSemanticStore as exportLegacyGitSemanticStore,
  importGitSemanticStore as importLegacyGitSemanticStore,
  type ExportGitSemanticStoreOptions,
} from "./experimental/git-semantic-store/index.js";
import { inspectDatabase, withReadonlyDb } from "./db.js";

const FORMAT = "vibehub.git-semantic-store";
const STORE_RELATIVE_PATH = ".vibehub/semantic-store";
const LEGACY_STORE_RELATIVE_PATH = ".vibehub/semantic-store/v1";
const HASH = /^[0-9a-f]{64}$/;

export const GIT_SEMANTIC_STORE_RELATIVE_PATH = STORE_RELATIVE_PATH;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bag = Record<string, unknown>;

interface LegacyEntry {
  id: string;
  file: string;
  sha256: string;
}

interface LegacyManifest {
  schema_version: 1;
  format: typeof FORMAT;
  repository: { slug: string | null; default_branch: string; created_at: string };
  features: LegacyEntry[];
  specs: LegacyEntry[];
  repo_provenance: Array<Bag & { event_id: number }>;
  semantic_digest: string;
}

interface DurableProvenance extends Bag {
  durable_id: string;
  operation: string;
  actor: string;
  task_id: string | null;
  request_id: string;
  at: string;
  payload: Json;
}

interface SemanticStoreProtocol {
  schema_version: 2;
  format: typeof FORMAT;
  indexing: "stable-identity-paths";
  integrity: "derived-from-canonical-tree";
  provenance_identity: "sha256-canonical-event-v1";
  repository: LegacyManifest["repository"];
}

export interface GitSemanticStoreExportResult {
  storePath: string;
  semanticDigest: string;
  featureCount: number;
  specCount: number;
  provenanceCount: number;
}

export interface RefReadResult {
  ref: string;
  commit: string;
  path: string;
  spec: Bag;
}

export interface RefSpecChange {
  status: "added" | "modified" | "deleted";
  specId: string;
  path: string;
}

export interface SemanticCacheResult {
  ref: string;
  commit: string;
  semanticDigest: string;
  dbPath: string;
  repoId: number;
  cacheHit: boolean;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const canonicalize = (value: unknown): Json => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("git semantic store: non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Bag)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  throw new Error(`git semantic store: unsupported value ${typeof value}`);
};

const serialize = (value: unknown): string => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const parseCanonical = (bytes: string, label: string): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    throw new Error(`git semantic store: invalid canonical JSON/YAML: ${label}`);
  }
  if (serialize(parsed) !== bytes) {
    throw new Error(`git semantic store: non-canonical bytes: ${label}`);
  }
  return parsed;
};

const bag = (value: unknown, label: string): Bag => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`git semantic store: ${label} must be an object`);
  }
  return value as Bag;
};

const exactBag = (value: unknown, keys: string[], label: string): Bag => {
  const result = bag(value, label);
  const actual = Object.keys(result).sort();
  const expected = keys.slice().sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) {
    throw new Error(`git semantic store: ${label} has unknown or missing fields`);
  }
  return result;
};

const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(`git semantic store: ${label} must be a canonical nonblank string`);
  }
  return value;
};

const runGit = (repoRoot: string, args: string[]): string => execFileSync("git", args, {
  cwd: repoRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

const resolveCommit = (repoRoot: string, ref: string): string => {
  const commit = runGit(repoRoot, [
    "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`,
  ]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`git semantic store: invalid commit for ${ref}`);
  return commit;
};

const show = (repoRoot: string, commit: string, file: string): string =>
  runGit(repoRoot, ["show", `${commit}:${file}`]);

const stableFile = (kind: "features" | "specs", id: string): string =>
  `${kind}/sha256-${sha256(id)}.yaml`;

export const stableSemanticPath = (
  kind: "features" | "specs",
  id: string,
): string => `${STORE_RELATIVE_PATH}/${stableFile(kind, id)}`;

const provenanceBody = (scope: string | null, event: Bag): Bag => {
  const { event_id: _ignored, durable_id: _existing, ...body } = event;
  return { scope, ...body };
};

export const durableProvenanceId = (scope: string | null, event: Bag): string =>
  sha256(serialize(provenanceBody(scope, event)));

const toDurableProvenance = (scope: string | null, event: Bag): DurableProvenance => {
  const body = provenanceBody(scope, event);
  const durableId = durableProvenanceId(scope, event);
  return {
    durable_id: durableId,
    operation: string(body.operation, "provenance.operation"),
    actor: string(body.actor, "provenance.actor"),
    task_id: body.task_id === null ? null : string(body.task_id, "provenance.task_id"),
    request_id: string(body.request_id, "provenance.request_id"),
    at: string(body.at, "provenance.at"),
    payload: canonicalize(body.payload),
  };
};

const fromDurableProvenance = (
  event: DurableProvenance,
  eventId: number,
): Bag & { event_id: number } => {
  const { durable_id: _ignored, ...body } = event;
  return { event_id: eventId, ...body };
};

const transformSpecToCanonical = (value: unknown): Bag => {
  const spec = bag(value, "spec");
  const specId = string(spec.spec_id, "spec.spec_id");
  if (!Array.isArray(spec.provenance)) {
    throw new Error(`git semantic store: spec provenance must be an array: ${specId}`);
  }
  const provenance = spec.provenance.map((event) =>
    toDurableProvenance(specId, bag(event, "spec.provenance event")));
  provenance.sort((left, right) =>
    left.at < right.at ? -1 :
      left.at > right.at ? 1 :
        left.durable_id < right.durable_id ? -1 : 1);
  return {
    ...spec,
    schema_version: 2,
    provenance,
  };
};

const transformFeatureToCanonical = (value: unknown): Bag => ({
  ...bag(value, "feature"),
  schema_version: 2,
});

const writeExclusive = (target: string, bytes: string): void => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { encoding: "utf8", flag: "wx" });
};

const inventoryDigest = (files: Array<{ path: string; bytes: string }>): string =>
  sha256(serialize(files.slice()
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => ({ path: file.path, sha256: sha256(file.bytes) }))));

export function exportGitSemanticStore(
  options: ExportGitSemanticStoreOptions,
): GitSemanticStoreExportResult {
  const finalStore = path.join(path.resolve(options.worktreeRoot), STORE_RELATIVE_PATH);
  if (fs.existsSync(finalStore)) {
    throw new Error(`git semantic store: destination already exists: ${finalStore}`);
  }
  const finalParent = path.dirname(finalStore);
  fs.mkdirSync(finalParent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(finalParent, ".semantic-adapter-"));
  const legacyWorktree = path.join(temp, "legacy-source");
  const staging = path.join(temp, "store");
  fs.mkdirSync(legacyWorktree, { recursive: true });
  try {
    const exported = exportLegacyGitSemanticStore({ ...options, worktreeRoot: legacyWorktree });
    const manifest = parseCanonical(
      fs.readFileSync(path.join(exported.storePath, "manifest.yaml"), "utf8"),
      "legacy manifest",
    ) as LegacyManifest;
    const protocol: SemanticStoreProtocol = {
      schema_version: 2,
      format: FORMAT,
      indexing: "stable-identity-paths",
      integrity: "derived-from-canonical-tree",
      provenance_identity: "sha256-canonical-event-v1",
      repository: manifest.repository,
    };
    const files: Array<{ path: string; bytes: string }> = [];
    const protocolBytes = serialize(protocol);
    writeExclusive(path.join(staging, "protocol.yaml"), protocolBytes);
    files.push({ path: "protocol.yaml", bytes: protocolBytes });

    for (const entry of manifest.features) {
      const source = path.join(exported.storePath, entry.file);
      const document = transformFeatureToCanonical(parseCanonical(fs.readFileSync(source, "utf8"), entry.file));
      const relative = stableFile("features", entry.id);
      const bytes = serialize(document);
      writeExclusive(path.join(staging, relative), bytes);
      files.push({ path: relative, bytes });
    }
    for (const entry of manifest.specs) {
      const source = path.join(exported.storePath, entry.file);
      const document = transformSpecToCanonical(parseCanonical(fs.readFileSync(source, "utf8"), entry.file));
      const relative = stableFile("specs", entry.id);
      const bytes = serialize(document);
      writeExclusive(path.join(staging, relative), bytes);
      files.push({ path: relative, bytes });
    }
    for (const raw of manifest.repo_provenance) {
      const event = toDurableProvenance(null, raw);
      const relative = `provenance/sha256-${event.durable_id}.yaml`;
      const bytes = serialize({ schema_version: 2, kind: "repo_provenance", ...event });
      writeExclusive(path.join(staging, relative), bytes);
      files.push({ path: relative, bytes });
    }

    fs.mkdirSync(path.dirname(finalStore), { recursive: true });
    fs.renameSync(staging, finalStore);
    return {
      storePath: finalStore,
      semanticDigest: inventoryDigest(files),
      featureCount: manifest.features.length,
      specCount: manifest.specs.length,
      provenanceCount: manifest.repo_provenance.length +
        manifest.specs.reduce((total, entry) => {
          const document = parseCanonical(
            fs.readFileSync(path.join(exported.storePath, entry.file), "utf8"),
            entry.file,
          ) as Bag;
          return total + (Array.isArray(document.provenance) ? document.provenance.length : 0);
        }, 0),
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const validateRefSpec = (value: unknown, expectedId: string, label: string): Bag => {
  const spec = exactBag(value, [
    "schema_version", "kind", "spec_id", "feature_id", "state",
    "current_revision", "source_kind", "created_at", "updated_at",
    "revisions", "relations", "provenance",
  ], label);
  if (spec.schema_version !== 2 || spec.kind !== "spec" || spec.spec_id !== expectedId) {
    throw new Error(`git semantic store: spec identity/protocol mismatch: ${label}`);
  }
  if (!Array.isArray(spec.provenance)) throw new Error(`git semantic store: missing provenance: ${label}`);
  for (const raw of spec.provenance) {
    const event = exactBag(raw, [
      "durable_id", "operation", "actor", "task_id", "request_id", "at", "payload",
    ], `${label}.provenance`);
    const durableId = string(event.durable_id, `${label}.provenance.durable_id`);
    if (!HASH.test(durableId) || durableId !== durableProvenanceId(expectedId, event)) {
      throw new Error(`git semantic store: invalid durable provenance identity: ${label}`);
    }
  }
  return spec;
};

const repoProvenanceFromDocument = (document: Bag, label: string): DurableProvenance => {
  const validated = exactBag(document, [
    "schema_version", "kind", "durable_id", "operation", "actor", "task_id",
    "request_id", "at", "payload",
  ], label);
  const { schema_version, kind, ...raw } = validated;
  if (schema_version !== 2 || kind !== "repo_provenance") {
    throw new Error(`git semantic store: invalid repo provenance protocol: ${label}`);
  }
  const event = raw as DurableProvenance;
  const durableId = string(event.durable_id, `${label}.durable_id`);
  if (!HASH.test(durableId) || durableId !== durableProvenanceId(null, event)) {
    throw new Error(`git semantic store: invalid repo provenance identity: ${label}`);
  }
  return event;
};

const validateProtocol = (value: unknown, label: string): SemanticStoreProtocol => {
  const protocol = exactBag(value, [
    "schema_version", "format", "indexing", "integrity",
    "provenance_identity", "repository",
  ], label);
  const repository = exactBag(protocol.repository, [
    "slug", "default_branch", "created_at",
  ], `${label}.repository`);
  if (protocol.schema_version !== 2 || protocol.format !== FORMAT ||
      protocol.indexing !== "stable-identity-paths" ||
      protocol.integrity !== "derived-from-canonical-tree" ||
      protocol.provenance_identity !== "sha256-canonical-event-v1" ||
      (repository.slug !== null && typeof repository.slug !== "string") ||
      typeof repository.default_branch !== "string" ||
      typeof repository.created_at !== "string") {
    throw new Error(`git semantic store: unsupported protocol: ${label}`);
  }
  return protocol as unknown as SemanticStoreProtocol;
};

const readProtocolAtCommit = (repoRoot: string, commit: string): SemanticStoreProtocol => {
  const file = `${STORE_RELATIVE_PATH}/protocol.yaml`;
  return validateProtocol(parseCanonical(show(repoRoot, commit, file), `${commit}:${file}`), file);
};

export function readSpecAtRef(repoRoot: string, ref: string, specId: string): RefReadResult {
  const commit = resolveCommit(repoRoot, ref);
  readProtocolAtCommit(repoRoot, commit);
  const file = stableSemanticPath("specs", specId);
  const bytes = show(repoRoot, commit, file);
  const spec = validateRefSpec(parseCanonical(bytes, `${commit}:${file}`), specId, file);
  return { ref, commit, path: file, spec };
}

const changeStatus = (status: string): RefSpecChange["status"] => {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  return "modified";
};

export function diffSemanticRefs(
  repoRoot: string,
  baseRef: string,
  targetRef: string,
): RefSpecChange[] {
  const base = resolveCommit(repoRoot, baseRef);
  const target = resolveCommit(repoRoot, targetRef);
  readProtocolAtCommit(repoRoot, base);
  readProtocolAtCommit(repoRoot, target);
  const raw = runGit(repoRoot, [
    "diff", "--name-status", "-z", base, target, "--", `${STORE_RELATIVE_PATH}/specs`,
  ]);
  const fields = raw.split("\0").filter(Boolean);
  const changes: RefSpecChange[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++]!;
    const file = fields[index++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      throw new Error("git semantic store: stable identity paths must not be renamed or copied");
    }
    const sourceCommit = status.startsWith("D") ? base : target;
    const document = bag(parseCanonical(show(repoRoot, sourceCommit, file), `${sourceCommit}:${file}`), file);
    const specId = string(document.spec_id, `${file}.spec_id`);
    if (file !== stableSemanticPath("specs", specId)) {
      throw new Error(`git semantic store: spec path does not match identity: ${file}`);
    }
    changes.push({ status: changeStatus(status), specId, path: file });
  }
  return changes.sort((left, right) => left.specId < right.specId ? -1 : left.specId > right.specId ? 1 : 0);
}

interface RefInventory {
  protocol: SemanticStoreProtocol;
  files: Array<{ path: string; bytes: string; document: Bag }>;
  semanticDigest: string;
}

export interface WorktreeSemanticStoreInspection {
  storePath: string;
  semanticDigest: string;
  featureCount: number;
  specCount: number;
  provenanceCount: number;
}

export interface WorktreeSemanticCacheResult extends WorktreeSemanticStoreInspection {
  dbPath: string;
  repoId: number;
}

const readRefInventory = (repoRoot: string, commit: string): RefInventory => {
  const prefix = `${STORE_RELATIVE_PATH}/`;
  const names = runGit(repoRoot, ["ls-tree", "-r", "--name-only", "-z", commit, "--", STORE_RELATIVE_PATH])
    .split("\0").filter(Boolean).sort();
  if (!names.includes(`${STORE_RELATIVE_PATH}/protocol.yaml`)) {
    throw new Error(`git semantic store: protocol missing at ${commit}`);
  }
  const files = names.map((name) => {
    const bytes = show(repoRoot, commit, name);
    return {
      path: name.slice(prefix.length),
      bytes,
      document: bag(parseCanonical(bytes, `${commit}:${name}`), name),
    };
  });
  const protocolFile = files.find((file) => file.path === "protocol.yaml")!;
  const protocol = validateProtocol(protocolFile.document, "protocol");
  for (const file of files) {
    if (file.path === "protocol.yaml") continue;
    if (file.path.startsWith("features/")) {
      const feature = exactBag(file.document, [
        "schema_version", "kind", "feature_id", "created_at",
      ], file.path);
      const id = string(feature.feature_id, `${file.path}.feature_id`);
      if (file.path !== stableFile("features", id) ||
          feature.schema_version !== 2 || feature.kind !== "feature") {
        throw new Error(`git semantic store: invalid feature path/protocol: ${file.path}`);
      }
    } else if (file.path.startsWith("specs/")) {
      const id = string(file.document.spec_id, `${file.path}.spec_id`);
      if (file.path !== stableFile("specs", id)) {
        throw new Error(`git semantic store: invalid spec path: ${file.path}`);
      }
      validateRefSpec(file.document, id, file.path);
    } else if (file.path.startsWith("provenance/")) {
      const event = repoProvenanceFromDocument(file.document, file.path);
      const durableId = string(event.durable_id, `${file.path}.durable_id`);
      if (file.path !== `provenance/sha256-${durableId}.yaml` ||
          durableId !== durableProvenanceId(null, event)) {
        throw new Error(`git semantic store: invalid repo provenance: ${file.path}`);
      }
    } else {
      throw new Error(`git semantic store: unknown inventory entry: ${file.path}`);
    }
  }
  return {
    protocol,
    files,
    semanticDigest: inventoryDigest(files.map(({ path: filePath, bytes }) => ({ path: filePath, bytes }))),
  };
};

const regularFiles = (directory: string, root: string = directory): string[] => {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`git semantic store: symbolic links are forbidden: ${absolute}`);
    }
    if (entry.isDirectory()) files.push(...regularFiles(absolute, root));
    else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    else throw new Error(`git semantic store: non-regular store entry: ${absolute}`);
  }
  return files;
};

const readWorktreeInventory = (repoRootInput: string): RefInventory => {
  const repoRoot = path.resolve(repoRootInput);
  const store = path.join(repoRoot, STORE_RELATIVE_PATH);
  if (!fs.statSync(store, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`git semantic store: store missing: ${store}`);
  }
  const names = regularFiles(store).sort();
  if (!names.includes("protocol.yaml")) {
    throw new Error(`git semantic store: protocol missing: ${store}`);
  }
  const files = names.map((relative) => {
    const bytes = fs.readFileSync(path.join(store, relative), "utf8");
    return {
      path: relative,
      bytes,
      document: bag(parseCanonical(bytes, `${store}:${relative}`), relative),
    };
  });
  const protocolFile = files.find((file) => file.path === "protocol.yaml")!;
  const protocol = validateProtocol(protocolFile.document, "protocol");
  for (const file of files) {
    if (file.path === "protocol.yaml") continue;
    if (file.path.startsWith("features/")) {
      const feature = exactBag(file.document, [
        "schema_version", "kind", "feature_id", "created_at",
      ], file.path);
      const id = string(feature.feature_id, `${file.path}.feature_id`);
      if (file.path !== stableFile("features", id) ||
          feature.schema_version !== 2 || feature.kind !== "feature") {
        throw new Error(`git semantic store: invalid feature path/protocol: ${file.path}`);
      }
    } else if (file.path.startsWith("specs/")) {
      const id = string(file.document.spec_id, `${file.path}.spec_id`);
      if (file.path !== stableFile("specs", id)) {
        throw new Error(`git semantic store: invalid spec path: ${file.path}`);
      }
      validateRefSpec(file.document, id, file.path);
    } else if (file.path.startsWith("provenance/")) {
      const event = repoProvenanceFromDocument(file.document, file.path);
      const durableId = string(event.durable_id, `${file.path}.durable_id`);
      if (file.path !== `provenance/sha256-${durableId}.yaml` ||
          durableId !== durableProvenanceId(null, event)) {
        throw new Error(`git semantic store: invalid repo provenance: ${file.path}`);
      }
    } else {
      throw new Error(`git semantic store: unknown inventory entry: ${file.path}`);
    }
  }
  return {
    protocol,
    files,
    semanticDigest: inventoryDigest(files.map(({ path: filePath, bytes }) => ({
      path: filePath,
      bytes,
    }))),
  };
};

export function hasGitSemanticStore(repoRoot: string): boolean {
  return fs.statSync(path.join(path.resolve(repoRoot), STORE_RELATIVE_PATH, "protocol.yaml"), {
    throwIfNoEntry: false,
  })?.isFile() === true;
}

export function inspectGitSemanticStoreWorktree(
  repoRoot: string,
): WorktreeSemanticStoreInspection {
  const inventory = readWorktreeInventory(repoRoot);
  return {
    storePath: path.join(path.resolve(repoRoot), STORE_RELATIVE_PATH),
    semanticDigest: inventory.semanticDigest,
    featureCount: inventory.files.filter((file) => file.path.startsWith("features/")).length,
    specCount: inventory.files.filter((file) => file.path.startsWith("specs/")).length,
    provenanceCount: inventory.files.filter((file) => file.path.startsWith("provenance/")).length +
      inventory.files.filter((file) => file.path.startsWith("specs/"))
        .reduce((total, file) =>
          total + ((file.document.provenance as unknown[] | undefined)?.length ?? 0), 0),
  };
}

const buildLegacyAdapter = (inventory: RefInventory, worktree: string): void => {
  const store = path.join(worktree, LEGACY_STORE_RELATIVE_PATH);
  const featureEntries: LegacyEntry[] = [];
  const specEntries: LegacyEntry[] = [];
  const provenance: Array<{ scope: string | null; event: DurableProvenance }> = [];
  fs.mkdirSync(path.join(store, "features"), { recursive: true });
  fs.mkdirSync(path.join(store, "specs"), { recursive: true });

  for (const file of inventory.files) {
    if (file.path.startsWith("features/")) {
      const document: Bag = { ...file.document, schema_version: 1 };
      const bytes = serialize(document);
      const contentHash = sha256(bytes);
      const relative = `features/sha256-${contentHash}.yaml`;
      writeExclusive(path.join(store, relative), bytes);
      featureEntries.push({
        id: string(document.feature_id, "feature.feature_id"),
        file: relative,
        sha256: contentHash,
      });
    } else if (file.path.startsWith("specs/")) {
      const specId = string(file.document.spec_id, "spec.spec_id");
      const rawEvents = file.document.provenance;
      if (!Array.isArray(rawEvents)) throw new Error(`git semantic store: invalid provenance: ${specId}`);
      for (const raw of rawEvents) provenance.push({
        scope: specId,
        event: raw as DurableProvenance,
      });
    } else if (file.path.startsWith("provenance/")) {
      provenance.push({
        scope: null,
        event: repoProvenanceFromDocument(file.document, file.path),
      });
    }
  }

  provenance.sort((left, right) =>
    left.event.at < right.event.at ? -1 :
      left.event.at > right.event.at ? 1 :
        left.event.durable_id < right.event.durable_id ? -1 : 1);
  const eventIds = new Map(provenance.map((item, index) => [item.event.durable_id, index + 1]));
  const repoProvenance = provenance.filter((item) => item.scope === null)
    .map((item) => fromDurableProvenance(item.event, eventIds.get(item.event.durable_id)!));

  for (const file of inventory.files.filter((item) => item.path.startsWith("specs/"))) {
    const specId = string(file.document.spec_id, "spec.spec_id");
    const rawEvents = file.document.provenance as DurableProvenance[];
    const document = {
      ...file.document,
      schema_version: 1,
      provenance: rawEvents.slice()
        .sort((left, right) => eventIds.get(left.durable_id)! - eventIds.get(right.durable_id)!)
        .map((event) =>
          fromDurableProvenance(event, eventIds.get(event.durable_id)!)),
    };
    const bytes = serialize(document);
    const contentHash = sha256(bytes);
    const relative = `specs/sha256-${contentHash}.yaml`;
    writeExclusive(path.join(store, relative), bytes);
    specEntries.push({ id: specId, file: relative, sha256: contentHash });
  }

  featureEntries.sort((left, right) => left.id < right.id ? -1 : 1);
  specEntries.sort((left, right) => left.id < right.id ? -1 : 1);
  const semanticDigest = sha256(serialize({
    features: featureEntries.map(({ id, sha256: contentHash }) => ({ id, sha256: contentHash })),
    specs: specEntries.map(({ id, sha256: contentHash }) => ({ id, sha256: contentHash })),
    repo_provenance: repoProvenance,
  }));
  const manifest: LegacyManifest = {
    schema_version: 1,
    format: FORMAT,
    repository: inventory.protocol.repository,
    features: featureEntries,
    specs: specEntries,
    repo_provenance: repoProvenance,
    semantic_digest: semanticDigest,
  };
  writeExclusive(path.join(store, "manifest.yaml"), serialize(manifest));
};

export function materializeSemanticCacheFromWorktree(options: {
  repoRoot: string;
  targetDbPath: string;
}): WorktreeSemanticCacheResult {
  const repoRoot = path.resolve(options.repoRoot);
  const inventory = readWorktreeInventory(repoRoot);
  const targetParent = path.dirname(path.resolve(options.targetDbPath));
  fs.mkdirSync(targetParent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(targetParent, ".worktree-adapter-"));
  try {
    const adapterWorktree = path.join(temp, "adapter");
    fs.mkdirSync(adapterWorktree, { recursive: true });
    buildLegacyAdapter(inventory, adapterWorktree);
    const imported = importLegacyGitSemanticStore({
      worktreeRoot: adapterWorktree,
      targetDbPath: options.targetDbPath,
      targetRepoRootPath: repoRoot,
    });
    const inspection = inspectGitSemanticStoreWorktree(repoRoot);
    return {
      ...inspection,
      semanticDigest: inventory.semanticDigest,
      dbPath: imported.dbPath,
      repoId: imported.repoId,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function replaceGitSemanticStore(options: {
  sourceDbPath: string;
  sourceRepoId: number;
  repoRoot: string;
  expectedSemanticDigest: string;
}): GitSemanticStoreExportResult {
  const repoRoot = path.resolve(options.repoRoot);
  const current = inspectGitSemanticStoreWorktree(repoRoot);
  if (current.semanticDigest !== options.expectedSemanticDigest) {
    throw new Error("git semantic store: concurrent worktree semantic change");
  }
  const actual = path.join(repoRoot, STORE_RELATIVE_PATH);
  const parent = path.dirname(actual);
  const stagingRoot = fs.mkdtempSync(path.join(parent, ".authority-write-"));
  const backup = path.join(parent, `.semantic-backup-${crypto.randomUUID()}`);
  let movedCurrent = false;
  try {
    const exported = exportGitSemanticStore({
      dbPath: options.sourceDbPath,
      repoId: options.sourceRepoId,
      worktreeRoot: stagingRoot,
    });
    if (exported.semanticDigest === current.semanticDigest) {
      return { ...exported, storePath: actual };
    }
    fs.renameSync(actual, backup);
    movedCurrent = true;
    fs.renameSync(exported.storePath, actual);
    try {
      const installed = inspectGitSemanticStoreWorktree(repoRoot);
      if (installed.semanticDigest !== exported.semanticDigest) {
        throw new Error("git semantic store: installed semantic digest mismatch");
      }
    } catch (error) {
      fs.rmSync(actual, { recursive: true, force: true });
      fs.renameSync(backup, actual);
      movedCurrent = false;
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    movedCurrent = false;
    return { ...exported, storePath: actual };
  } finally {
    if (movedCurrent && !fs.existsSync(actual) && fs.existsSync(backup)) {
      fs.renameSync(backup, actual);
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

export function migrateSqliteSemanticStoreToGit(options: {
  sourceDbPath: string;
  sourceRepoId: number;
  repoRoot: string;
}): GitSemanticStoreExportResult {
  const repoRoot = path.resolve(options.repoRoot);
  if (hasGitSemanticStore(repoRoot)) {
    throw new Error(`git semantic store: repository is already migrated: ${repoRoot}`);
  }
  if (runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") {
    throw new Error("git semantic store: migration requires a clean worktree");
  }
  const sourceBytes = fs.statSync(path.resolve(options.sourceDbPath)).size;
  const space = fs.statfsSync(repoRoot);
  const availableBytes = Number(space.bavail) * Number(space.bsize);
  if (availableBytes < Math.max(sourceBytes * 3, 16 * 1024 * 1024)) {
    throw new Error("git semantic store: insufficient disk space for migration proof");
  }
  const actual = path.join(repoRoot, STORE_RELATIVE_PATH);
  const parent = path.dirname(actual);
  fs.mkdirSync(parent, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(parent, ".authority-migration-"));
  const proofRoot = fs.mkdtempSync(path.join(parent, ".authority-proof-"));
  const proofDb = path.join(proofRoot, "rebuilt.db");
  try {
    const exported = exportGitSemanticStore({
      dbPath: options.sourceDbPath,
      repoId: options.sourceRepoId,
      worktreeRoot: stagingRoot,
    });
    const rebuilt = materializeSemanticCacheFromWorktree({
      repoRoot: stagingRoot,
      targetDbPath: proofDb,
    });
    if (rebuilt.semanticDigest !== exported.semanticDigest) {
      throw new Error("git semantic store: migration cache digest mismatch");
    }
    const reexportRoot = path.join(proofRoot, "reexport");
    fs.mkdirSync(reexportRoot);
    const reexported = exportGitSemanticStore({
      dbPath: proofDb,
      repoId: rebuilt.repoId,
      worktreeRoot: reexportRoot,
    });
    if (reexported.semanticDigest !== exported.semanticDigest) {
      throw new Error("git semantic store: migration byte re-export mismatch");
    }
    fs.renameSync(exported.storePath, actual);
    const installed = inspectGitSemanticStoreWorktree(repoRoot);
    if (installed.semanticDigest !== exported.semanticDigest) {
      fs.rmSync(actual, { recursive: true, force: true });
      throw new Error("git semantic store: installed migration digest mismatch");
    }
    return { ...exported, storePath: actual };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(proofRoot, { recursive: true, force: true });
  }
}

export function materializeSemanticCacheAtRef(options: {
  repoRoot: string;
  ref: string;
  cacheRoot: string;
}): SemanticCacheResult {
  const repoRoot = path.resolve(options.repoRoot);
  const commit = resolveCommit(repoRoot, options.ref);
  const inventory = readRefInventory(repoRoot, commit);
  const commonDirRaw = runGit(repoRoot, ["rev-parse", "--git-common-dir"]).trim();
  const commonDir = path.resolve(repoRoot, commonDirRaw);
  const repoKey = sha256(commonDir);
  const directory = path.join(path.resolve(options.cacheRoot), repoKey);
  const dbPath = path.join(directory, `${commit}-${inventory.semanticDigest}.db`);
  if (fs.existsSync(dbPath)) {
    const inspection = inspectDatabase(dbPath);
    if (!inspection.readable || inspection.schemaVersion !== inspection.expectedSchemaVersion) {
      throw new Error(`git semantic store: cache exists but is invalid: ${dbPath}`);
    }
    const repoId = withReadonlyDb(dbPath, (db) =>
      (db.prepare("SELECT id FROM repos ORDER BY id LIMIT 1").get() as { id: number }).id);
    return {
      ref: options.ref,
      commit,
      semanticDigest: inventory.semanticDigest,
      dbPath,
      repoId,
      cacheHit: true,
    };
  }

  fs.mkdirSync(directory, { recursive: true });
  const temp = fs.mkdtempSync(path.join(directory, ".materialize-"));
  try {
    const adapterWorktree = path.join(temp, "adapter");
    fs.mkdirSync(adapterWorktree, { recursive: true });
    buildLegacyAdapter(inventory, adapterWorktree);
    let imported: ReturnType<typeof importLegacyGitSemanticStore>;
    try {
      imported = importLegacyGitSemanticStore({
        worktreeRoot: adapterWorktree,
        targetDbPath: dbPath,
        targetRepoRootPath: repoRoot,
      });
    } catch (error) {
      if (!fs.existsSync(dbPath)) throw error;
      const inspection = inspectDatabase(dbPath);
      if (!inspection.readable || inspection.schemaVersion !== inspection.expectedSchemaVersion) {
        throw error;
      }
      const repoId = withReadonlyDb(dbPath, (db) =>
        (db.prepare("SELECT id FROM repos ORDER BY id LIMIT 1").get() as { id: number }).id);
      return {
        ref: options.ref,
        commit,
        semanticDigest: inventory.semanticDigest,
        dbPath,
        repoId,
        cacheHit: true,
      };
    }
    return {
      ref: options.ref,
      commit,
      semanticDigest: inventory.semanticDigest,
      dbPath: imported.dbPath,
      repoId: imported.repoId,
      cacheHit: false,
    };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
