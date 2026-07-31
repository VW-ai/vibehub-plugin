import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { openDb, type Db } from "./db.js";
import {
  KB_RELATION_TYPES,
  KB_SPEC_STATES,
  KB_SPEC_TYPES,
  type KbRelationType,
  type KbSpecState,
} from "./contract/kb-types.js";
import {
  inspectGitSemanticStoreWorktree,
  materializeSemanticCacheFromWorktree,
  replaceGitSemanticStore,
} from "./git-semantic-store.js";
import { canonicalRepoPath } from "./scope-registry.js";

const canonical = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => value === value.trim(), "must be a canonical nonblank string");
const metaSpecSchema = z.object({
  spec_id: canonical(200),
  type: z.enum(KB_SPEC_TYPES),
  state: z.enum(KB_SPEC_STATES),
  intent: z.object({
    summary: canonical(300),
    detail: z.string().max(20_000).optional(),
  }).strict(),
  constraints: z.array(z.object({
    kind: canonical(100),
    rule: canonical(20_000),
  }).strict()).max(50).optional(),
  indexing: z.object({
    type: z.enum(KB_SPEC_TYPES),
    priority: canonical(200).optional(),
    layer: canonical(200).optional(),
    domain: canonical(200).optional(),
    tags: z.array(canonical(100)).max(50).optional(),
  }).strict(),
  provenance: z.object({
    source_type: canonical(200),
    confidence: z.number().min(0).max(1).optional(),
    source_ref: canonical(2_000).optional(),
    produced_at: canonical(200).optional(),
    produced_by_agent: canonical(200).optional(),
    migration: z.unknown().optional(),
  }).strict(),
  relations: z.array(z.object({
    target: canonical(200),
    type: canonical(100),
    detail: z.string().max(20_000).optional(),
  }).strict()).max(100).optional(),
  anchors: z.array(z.object({
    file: canonical(1_000),
    symbols: z.array(canonical(500)).max(100).optional(),
  }).strict()).max(100).optional(),
}).strict().refine(
  (spec) => spec.type === spec.indexing.type,
  { message: "type and indexing.type must match" },
);

type MetaSpec = z.infer<typeof metaSpecSchema>;

interface SelectedMetaSpec {
  document: MetaSpec;
  sourcePath: string;
  absolutePath: string;
  featureId: string;
  sourceSha256: string;
  legacy: boolean;
}

interface UnvalidatedMetaSpec extends Omit<SelectedMetaSpec, "document" | "featureId"> {
  specId: string;
  document: unknown;
}

interface CanonicalRelation {
  fromSpecId: string;
  toSpecId: string;
  type: KbRelationType;
  rationale: string | null;
}

export interface MetaCanonicalMigrationOptions {
  repoRoot: string;
  sourceDirectory?: string;
  actor: string;
  taskId: string;
  requestId: string;
  now: string;
}

export interface MetaCanonicalMigrationResult {
  operation: "kb.migrate-meta";
  sourceDirectory: string;
  sourceFileCount: number;
  selectedSpecCount: number;
  duplicateSourceCount: number;
  skippedRelationCount: number;
  normalizedAnchorPathCount: number;
  canonicalRelationCount: number;
  stateCounts: Record<KbSpecState, number>;
  finalSpecCount: number;
  finalFeatureCount: number;
  semanticDigest: string;
  storePath: string;
  selectedSources: Array<{ specId: string; sourcePath: string }>;
  skippedSources: Array<{ specId: string; sourcePath: string; selectedPath: string }>;
  skippedRelations: Array<{ sourceSpecId: string; type: string; targetSpecId: string; sourcePath: string }>;
  normalizedAnchors: Array<{ specId: string; from: string; to: string }>;
}

const sha256 = (value: string | Buffer): string =>
  crypto.createHash("sha256").update(value).digest("hex");

const required = (value: string, label: string, maximum = 20_000): string => {
  if (!value || value !== value.trim() || [...value].length > maximum) {
    throw new Error(`META canonical migration: invalid ${label}`);
  }
  return value;
};

const canonicalPath = (value: string, label: string): string => {
  let normalized: string;
  try {
    normalized = canonicalRepoPath(value);
  } catch {
    throw new Error(`META canonical migration: ${label} is not a canonical repo-relative path`);
  }
  if (normalized !== value) {
    throw new Error(`META canonical migration: ${label} is not a canonical repo-relative path`);
  }
  return normalized;
};

const parseYaml = (file: string): unknown => {
  const document = YAML.parseDocument(fs.readFileSync(file, "utf8"), {
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(`META canonical migration: invalid YAML ${file}: ${document.errors[0]!.message}`);
  }
  return document.toJS();
};

const listMetaSpecFiles = (directory: string): string[] => {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`META canonical migration: symbolic links are forbidden: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.basename(current) === "specs" && /\.ya?ml$/u.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  visit(directory);
  return files.sort();
};

const roomFeatureId = (specFile: string): string => {
  const roomFile = path.join(path.dirname(path.dirname(specFile)), "room.yaml");
  if (!fs.existsSync(roomFile)) {
    throw new Error(`META canonical migration: missing room.yaml for ${specFile}`);
  }
  const value = parseYaml(roomFile) as { id?: unknown; room?: { id?: unknown } };
  const id = value.room?.id ?? value.id;
  if (typeof id !== "string") {
    throw new Error(`META canonical migration: room identity is missing in ${roomFile}`);
  }
  return required(id, `feature ID in ${roomFile}`, 200);
};

const normalizedProducedAt = (value: string | undefined, fallback: string): string => {
  if (!value) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T00:00:00.000Z`;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`META canonical migration: invalid provenance.produced_at: ${value}`);
  }
  return value;
};

const collectSelectedSpecs = (repoRoot: string, sourceRoot: string) => {
  const files = listMetaSpecFiles(sourceRoot);
  const groups = new Map<string, UnvalidatedMetaSpec[]>();
  for (const absolutePath of files) {
    const document = parseYaml(absolutePath);
    const identity = z.object({ spec_id: canonical(200) }).passthrough().safeParse(document);
    if (!identity.success) throw new Error(`META canonical migration: missing spec_id in ${path.relative(repoRoot, absolutePath)}`);
    const sourcePath = path.relative(repoRoot, absolutePath).split(path.sep).join("/");
    canonicalPath(sourcePath, "source path");
    const selected: UnvalidatedMetaSpec = {
      specId: identity.data.spec_id,
      document,
      sourcePath,
      absolutePath,
      sourceSha256: sha256(fs.readFileSync(absolutePath)),
      legacy: sourcePath.split("/").includes("legacy-21-workbench"),
    };
    const group = groups.get(selected.specId) ?? [];
    group.push(selected);
    groups.set(selected.specId, group);
  }

  const selected: SelectedMetaSpec[] = [];
  const skippedSources: MetaCanonicalMigrationResult["skippedSources"] = [];
  for (const [specId, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const current = group.filter((item) => !item.legacy);
    if (current.length > 1 || (current.length === 0 && group.length > 1)) {
      throw new Error(`META canonical migration: ambiguous duplicate source for ${specId}`);
    }
    const rawChoice = current[0] ?? group[0]!;
    const parsed = metaSpecSchema.safeParse(rawChoice.document);
    if (!parsed.success) {
      throw new Error(`META canonical migration: invalid spec ${rawChoice.sourcePath}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    const choice: SelectedMetaSpec = {
      ...rawChoice,
      document: parsed.data,
      featureId: roomFeatureId(rawChoice.absolutePath),
    };
    selected.push(choice);
    for (const skipped of group.filter((item) => item !== rawChoice)) {
      skippedSources.push({ specId, sourcePath: skipped.sourcePath, selectedPath: rawChoice.sourcePath });
    }
  }
  return { files, selected, skippedSources };
};

const relationRationale = (
  sourceSpecId: string,
  relation: NonNullable<MetaSpec["relations"]>[number],
): string | null => {
  if (KB_RELATION_TYPES.includes(relation.type as KbRelationType) ||
      relation.type === "superseded_by") {
    return relation.detail ?? null;
  }
  return relation.detail
    ? `META ${relation.type} relation from ${sourceSpecId}: ${relation.detail}`
    : `META ${relation.type} relation from ${sourceSpecId}`;
};

const collectRelations = (selected: SelectedMetaSpec[]) => {
  const ids = new Set(selected.map((item) => item.document.spec_id));
  const edges = new Map<string, CanonicalRelation & { rationales: Set<string> }>();
  const skippedRelations: MetaCanonicalMigrationResult["skippedRelations"] = [];
  for (const source of selected) {
    for (const relation of source.document.relations ?? []) {
      if (!ids.has(relation.target)) {
        skippedRelations.push({
          sourceSpecId: source.document.spec_id,
          type: relation.type,
          targetSpecId: relation.target,
          sourcePath: source.sourcePath,
        });
        continue;
      }
      let fromSpecId = source.document.spec_id;
      let toSpecId = relation.target;
      let type: KbRelationType;
      if (relation.type === "supersedes") {
        fromSpecId = relation.target;
        toSpecId = source.document.spec_id;
        type = "supersedes";
      } else if (relation.type === "superseded_by") {
        type = "supersedes";
      } else if (KB_RELATION_TYPES.includes(relation.type as KbRelationType)) {
        type = relation.type as KbRelationType;
      } else {
        type = "relates_to";
      }
      if (fromSpecId === toSpecId) {
        throw new Error(`META canonical migration: self relation is forbidden for ${fromSpecId}`);
      }
      const key = `${fromSpecId}\0${toSpecId}\0${type}`;
      const rationale = relationRationale(source.document.spec_id, relation);
      const existing = edges.get(key) ?? {
        fromSpecId,
        toSpecId,
        type,
        rationale: null,
        rationales: new Set<string>(),
      };
      if (rationale) existing.rationales.add(rationale);
      edges.set(key, existing);
    }
  }
  const relations = [...edges.values()].map(({ rationales, ...edge }) => ({
    ...edge,
    rationale: rationales.size ? [...rationales].sort().join("\n\n") : null,
  })).sort((left, right) =>
    left.fromSpecId.localeCompare(right.fromSpecId) ||
    left.type.localeCompare(right.type) ||
    left.toSpecId.localeCompare(right.toSpecId));
  for (const relation of relations) {
    if (relation.rationale !== null && [...relation.rationale].length > 20_000) {
      throw new Error(`META canonical migration: normalized relation rationale exceeds 20000 characters: ${relation.fromSpecId} -> ${relation.toSpecId}`);
    }
  }
  validateAcyclicRelations(relations, "depends_on");
  validateAcyclicRelations(relations, "supersedes");
  return { relations, skippedRelations };
};

const validateAcyclicRelations = (relations: CanonicalRelation[], type: KbRelationType): void => {
  const outgoing = new Map<string, string[]>();
  for (const relation of relations.filter((item) => item.type === type)) {
    const targets = outgoing.get(relation.fromSpecId) ?? [];
    targets.push(relation.toSpecId);
    outgoing.set(relation.fromSpecId, targets);
  }
  const visiting = new Set<string>();
  const complete = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`META canonical migration: ${type} relation cycle at ${id}`);
    if (complete.has(id)) return;
    visiting.add(id);
    for (const target of outgoing.get(id) ?? []) visit(target);
    visiting.delete(id);
    complete.add(id);
  };
  for (const id of outgoing.keys()) visit(id);
};

const evidenceId = (specId: string, suffix: string): string => {
  const candidate = `${specId}:1:${suffix}`;
  return candidate.length <= 200 ? candidate : `${specId.slice(0, 120)}:${sha256(candidate)}`;
};

const insertSelectedSpecs = (
  db: Db,
  repoId: number,
  selected: SelectedMetaSpec[],
  relations: CanonicalRelation[],
  options: MetaCanonicalMigrationOptions,
) => {
  const normalizedAnchors: MetaCanonicalMigrationResult["normalizedAnchors"] = [];
  const stateCounts = Object.fromEntries(KB_SPEC_STATES.map((state) => [state, 0])) as Record<KbSpecState, number>;
  const insertSpec = db.prepare(`INSERT INTO kb_specs(repo_id,spec_id,feature_id,state,current_revision,source_kind,created_at,updated_at) VALUES(?,?,?,?,1,'canonical',?,?)`);
  const insertRevision = db.prepare(`INSERT INTO kb_spec_revisions(repo_id,spec_id,revision,type,summary,detail,priority,layer,domain,tags,producer,produced_at) VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`);
  const insertEvidence = db.prepare(`INSERT INTO kb_evidence(repo_id,evidence_id,spec_id,revision,source_type,source_ref,exact_quote,evidence_ref,content_hash,confidence,producer,produced_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?)`);
  const insertAnchor = db.prepare(`INSERT INTO kb_spec_revision_anchors(repo_id,spec_id,revision,file,symbol,line_start,line_end,content_hash) VALUES(?,?,1,?,?,NULL,NULL,NULL)`);
  const insertCurrentAnchor = db.prepare(`INSERT INTO kb_spec_current_anchors(repo_id,spec_id,revision,file,symbol,line_start,line_end,content_hash) VALUES(?,?,1,?,?,NULL,NULL,NULL)`);
  const insertProvenance = db.prepare(`INSERT INTO kb_provenance_events(repo_id,operation,spec_id,actor,task_id,request_id,at,payload) VALUES(?,'meta_canonical_migration',?,?,?,?,?,?)`);
  for (const source of selected) {
    const spec = source.document;
    if (db.prepare(`SELECT 1 FROM kb_specs WHERE repo_id=? AND spec_id=?`).get(repoId, spec.spec_id)) {
      throw new Error(`META canonical migration: canonical spec already exists: ${spec.spec_id}`);
    }
    if (!db.prepare(`SELECT 1 FROM kb_features WHERE repo_id=? AND feature_id=?`).get(repoId, source.featureId)) {
      throw new Error(`META canonical migration: feature does not exist: ${source.featureId}`);
    }
    const producedAt = normalizedProducedAt(spec.provenance.produced_at, options.now);
    const producer = spec.provenance.produced_by_agent
      ? `meta:${spec.provenance.produced_by_agent}`
      : "meta-migration";
    insertSpec.run(repoId, spec.spec_id, source.featureId, spec.state, producedAt, producedAt);
    insertRevision.run(
      repoId,
      spec.spec_id,
      spec.type,
      spec.intent.summary,
      spec.intent.detail ?? null,
      spec.indexing.priority ?? null,
      spec.indexing.layer ?? null,
      spec.indexing.domain ?? null,
      JSON.stringify(spec.indexing.tags ?? []),
      producer,
      producedAt,
    );
    const contentHash = `sha256:${source.sourceSha256}`;
    insertEvidence.run(
      repoId,
      evidenceId(spec.spec_id, "meta-source"),
      spec.spec_id,
      spec.provenance.source_type,
      source.sourcePath,
      spec.intent.summary,
      spec.provenance.source_ref ?? null,
      contentHash,
      spec.provenance.confidence ?? null,
      producer,
      producedAt,
    );
    for (const [index, constraint] of (spec.constraints ?? []).entries()) {
      insertEvidence.run(
        repoId,
        evidenceId(spec.spec_id, `constraint-${index + 1}`),
        spec.spec_id,
        "meta_constraint",
        source.sourcePath,
        `[${constraint.kind}] ${constraint.rule}`,
        spec.provenance.source_ref ?? null,
        contentHash,
        spec.provenance.confidence ?? null,
        producer,
        producedAt,
      );
    }
    const anchors = new Set<string>();
    for (const anchor of spec.anchors ?? []) {
      const normalized = anchor.file.endsWith("/") ? anchor.file.slice(0, -1) : anchor.file;
      canonicalPath(normalized, `anchor in ${source.sourcePath}`);
      if (normalized !== anchor.file) {
        normalizedAnchors.push({ specId: spec.spec_id, from: anchor.file, to: normalized });
      }
      for (const symbol of anchor.symbols?.length ? anchor.symbols : [""]) {
        const key = `${normalized}\0${symbol}`;
        if (anchors.has(key)) continue;
        anchors.add(key);
        insertAnchor.run(repoId, spec.spec_id, normalized, symbol);
        insertCurrentAnchor.run(repoId, spec.spec_id, normalized, symbol);
      }
    }
    insertProvenance.run(
      repoId,
      spec.spec_id,
      options.actor,
      options.taskId,
      options.requestId,
      options.now,
      JSON.stringify({
        revision: 1,
        state: spec.state,
        validation: "passed",
        migration: {
          format: "context-os-meta-spec-v1",
          sourcePath: source.sourcePath,
          sourceContentSha256: contentHash,
          sourceState: spec.state,
          sourceProvenance: spec.provenance,
          constraintCount: spec.constraints?.length ?? 0,
        },
      }),
    );
    stateCounts[spec.state] += 1;
  }
  const insertRelation = db.prepare(`INSERT INTO kb_spec_relations(repo_id,from_spec_id,to_spec_id,type,rationale,created_at) VALUES(?,?,?,?,?,?)`);
  for (const relation of relations) {
    insertRelation.run(repoId, relation.fromSpecId, relation.toSpecId, relation.type, relation.rationale, options.now);
  }
  return { normalizedAnchors, stateCounts };
};

export function migrateMetaSpecsToCanonical(
  options: MetaCanonicalMigrationOptions,
): MetaCanonicalMigrationResult {
  const repoRoot = fs.realpathSync(options.repoRoot);
  const sourceDirectory = canonicalPath(options.sourceDirectory ?? "META", "source directory");
  required(options.actor, "actor", 200);
  required(options.taskId, "taskId", 200);
  required(options.requestId, "requestId", 200);
  if (Number.isNaN(Date.parse(options.now))) throw new Error("META canonical migration: now must be an ISO timestamp");
  const sourceRoot = path.resolve(repoRoot, sourceDirectory);
  if (!fs.existsSync(sourceRoot) || fs.lstatSync(sourceRoot).isSymbolicLink() ||
      !fs.lstatSync(sourceRoot).isDirectory()) {
    throw new Error(`META canonical migration: source must be a real directory: ${sourceDirectory}`);
  }
  const before = inspectGitSemanticStoreWorktree(repoRoot);
  const collected = collectSelectedSpecs(repoRoot, sourceRoot);
  if (!collected.selected.length) throw new Error("META canonical migration: no spec sources found");
  const relationPlan = collectRelations(collected.selected);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-meta-migration-"));
  const cachePath = path.join(temp, "semantic.db");
  let db: Db | undefined;
  try {
    const materialized = materializeSemanticCacheFromWorktree({ repoRoot, targetDbPath: cachePath });
    db = openDb(cachePath);
    let inserted!: ReturnType<typeof insertSelectedSpecs>;
    db.transaction(() => {
      inserted = insertSelectedSpecs(
        db!,
        materialized.repoId,
        collected.selected,
        relationPlan.relations,
        options,
      );
      const foreignKeys = db!.prepare(`PRAGMA foreign_key_check`).all();
      if (foreignKeys.length) throw new Error("META canonical migration: imported foreign key violation");
      db!.prepare(`INSERT INTO kb_provenance_events(repo_id,operation,spec_id,actor,task_id,request_id,at,payload) VALUES(?,'meta_canonical_migration',NULL,?,?,?,?,?)`).run(
        materialized.repoId,
        options.actor,
        options.taskId,
        options.requestId,
        options.now,
        JSON.stringify({
          sourceDirectory,
          sourceFileCount: collected.files.length,
          selectedSpecCount: collected.selected.length,
          duplicateSourceCount: collected.skippedSources.length,
          skippedRelationCount: relationPlan.skippedRelations.length,
          normalizedAnchorPathCount: inserted.normalizedAnchors.length,
          canonicalRelationCount: relationPlan.relations.length,
          stateCounts: inserted.stateCounts,
        }),
      );
    }).immediate();
    db.close();
    db = undefined;
    const installed = replaceGitSemanticStore({
      sourceDbPath: cachePath,
      sourceRepoId: materialized.repoId,
      repoRoot,
      expectedSemanticDigest: before.semanticDigest,
    });
    return {
      operation: "kb.migrate-meta",
      sourceDirectory,
      sourceFileCount: collected.files.length,
      selectedSpecCount: collected.selected.length,
      duplicateSourceCount: collected.skippedSources.length,
      skippedRelationCount: relationPlan.skippedRelations.length,
      normalizedAnchorPathCount: inserted.normalizedAnchors.length,
      canonicalRelationCount: relationPlan.relations.length,
      stateCounts: inserted.stateCounts,
      finalSpecCount: installed.specCount,
      finalFeatureCount: installed.featureCount,
      semanticDigest: installed.semanticDigest,
      storePath: installed.storePath,
      selectedSources: collected.selected.map((source) => ({
        specId: source.document.spec_id,
        sourcePath: source.sourcePath,
      })),
      skippedSources: collected.skippedSources,
      skippedRelations: relationPlan.skippedRelations,
      normalizedAnchors: inserted.normalizedAnchors,
    };
  } finally {
    db?.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
