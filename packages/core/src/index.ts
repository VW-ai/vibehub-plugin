export * from "./contract/map-types.js";
export * from "./contract/panel-types.js";
export * from "./contract/conflict-types.js";
export * from "./contract/install-types.js";
export * from "./contract/kb-types.js";
export * from "./contract/workbench-bridge.js";
export * from "./contract/workflow-receipt.js";
export {
  defaultDbPath,
  openDb,
  resolveDbPath,
  vibehubHome,
  type Db,
  CURRENT_SCHEMA_VERSION,
  inspectDatabase,
  withReadonlyDb,
  type DatabaseInspection,
} from "./db.js";
export * from "./runtime-lifecycle.js";
export * from "./project-activation.js";
export * from "./activity-store.js";
// GraphStore is a read-model compatibility facade after the KB v2 cutover.
// Canonical/mapping writes are intentionally not part of the package API.
export {
  listTerritories, readTerritoryLayouts, countAnchoredFiles, featuresForFile,
  readSpec, edgesFrom, getSetting, type SpecRow, type SpecType,
} from "./graph-store.js";
export {
  GitFacade,
  GhFacade,
  GitError,
  parseRemoteSlug,
  type RemoteBranch,
  type BranchFile,
  type PrFact,
} from "./git-facade.js";
export {
  getRepoByRoot,
  upsertRepo,
  readBranchFiles,
  readConflicts,
  readSyncState,
  readTeamBranches,
  type RepoRow,
  type SyncStateRow,
  type TeamBranchRow,
  type TeamConflictRow,
} from "./team-store.js";
export {
  selectConflictCandidates,
  syncTeamSnapshot,
  type TeamSyncOptions,
  type TeamSyncResult,
} from "./team-sync.js";
export { exportTeamMapSnapshot } from "./snapshot-export.js";
export {
  RuntimeService,
  resolveWorkbenchRepoRef,
  type RuntimeServiceOptions,
} from "./runtime-service.js";
export { readTaskTimeline } from "./timeline-read.js";
export {
  canonicalConflictPair,
  isConflictPairIgnored,
  persistIgnoredConflictPair,
  resolveConflictPair,
} from "./conflict-ignore.js";
export { readTaskPanelModel, readConflictDetailModel } from "./live-read-models.js";
export {
  applyIntervention,
  InterventionTargetNotFoundError,
  type ApplyInterventionInput,
} from "./intervention-service.js";
export {
  squarify,
  layoutTerritories,
  DEFAULT_LAYOUT,
  type TreemapItem,
  type LayoutOptions,
} from "./treemap.js";
export { nextState, type HookEventName } from "./state-machine.js";
export { classifyUserPrompt, type PromptClassification } from "./milestone.js";
export {
  canonicalRepoPath,
  claimOffScopeReminder,
  matchesScopePattern,
  readScopePatterns,
  replaceScopePatterns,
  type ScopePattern,
} from "./scope-registry.js";
export * from "./knowledge-service.js";
export * from "./distillation-service.js";
export * from "./operation-dispatcher.js";
export * from "./operation-contracts.js";
export {
  ingestHookEvent,
  lastAssistantText,
  type HookPayload,
  type HookIngestResult,
} from "./hook-ingest.js";
export {
  CHECKPOINT_CADENCE_SETTING_KEY,
  DEFAULT_CHECKPOINT_CADENCE_TURNS,
  formatCheckpointReminder,
  recordUserPromptTurn,
  resolveCheckpointCadence,
  type CheckpointCadenceFacts,
  type CheckpointStatus,
  type CheckpointTurnInput,
} from "./knowledge-checkpoint.js";
export * from "./workflow-receipt-projectors.js";
