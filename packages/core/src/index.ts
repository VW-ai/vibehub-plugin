export * from "./contract/map-types.js";
export { defaultDbPath, openDb, type Db } from "./db.js";
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
export {
  exportTeamMapFixture,
  UNCATEGORIZED_TERRITORY_ID,
} from "./fixture-export.js";
