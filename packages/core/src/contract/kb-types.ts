/** Canonical Feature Room ontology persisted by the v2 knowledge boundary. */
export const KB_SPEC_TYPES = [
  "intent", "decision", "constraint", "convention", "contract", "context", "change",
] as const;
export type KbSpecType = (typeof KB_SPEC_TYPES)[number];

/**
 * Exact lifecycle (amendment creates a revision and does not move state):
 *
 * draft ──▶ active ──▶ stale ──▶ superseded
 *   └────────┴──────────┴──────▶ deprecated
 *              └──────────────▶ superseded
 *
 * superseded and deprecated are terminal.
 */
export const KB_SPEC_STATES = ["draft", "active", "stale", "superseded", "deprecated"] as const;
export type KbSpecState = (typeof KB_SPEC_STATES)[number];

/** Canonical relation direction. In particular supersedes is OLD -> NEW. */
export const KB_RELATION_TYPES = ["depends_on", "relates_to", "supersedes", "conflicts_with"] as const;
export type KbRelationType = (typeof KB_RELATION_TYPES)[number];

/** Makes canonical truth and inferred/version material impossible to confuse. */
export type KnowledgeSourceKind = "canonical" | "version_candidate";

/**
 * Two independent truth layers:
 * canonical KB (reviewed identities + immutable revisions)
 *                  │ explicit promotion only
 *                  ╳ mapping activation never mutates this layer
 * immutable mapping version ──CAS activate──▶ repo active mapping pointer
 */
export interface MappingVersionIdentity {
  repoId: number;
  versionId: string;
  sourceKind: "legacy_import" | "distillation";
  state: "building" | "finalized";
  checksum: string;
}
