export * from "./contract/map-types.js";
export * from "./contract/panel-types.js";
export * from "./contract/conflict-types.js";
export * from "./contract/install-types.js";
export {
  defaultDbPath,
  openDb,
  resolveDbPath,
  vibehubHome,
  type Db,
} from "./db.js";
export * from "./activity-store.js";
export * from "./graph-store.js";
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
export { exportTeamMapFixture } from "./fixture-export.js";
export { readTaskTimeline } from "./timeline-read.js";
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
export {
  applyDistillation,
  markSpecStale,
  recordSpec,
  retrieveKnowledge,
  type DistillationManifest,
  type RecordSpecInput,
  type SpecRow,
  type SpecType,
  type KnowledgeResult,
} from "./graph-store.js";
export {
  ingestHookEvent,
  lastAssistantText,
  type HookPayload,
  type HookIngestResult,
} from "./hook-ingest.js";
