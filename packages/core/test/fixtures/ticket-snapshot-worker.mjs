import fs from "node:fs";
import {
  GitFacade,
  GitTicketReviewProjectionSourceProviderV0,
} from "../../dist/index.js";

const [worktreeRoot, snapshotId] = process.argv.slice(2);
if (!worktreeRoot || !snapshotId) {
  throw new Error("usage: ticket-snapshot-worker <worktreeRoot> <snapshotId>");
}
const session = GitFacade.sessionContextAt(worktreeRoot);
const provider = new GitTicketReviewProjectionSourceProviderV0();
const result = provider.loadSnapshot({
  repoId: 1,
  repositoryRoot: fs.realpathSync(session.repoRoot),
  worktreeRoot: fs.realpathSync(session.toplevel),
}, snapshotId);
process.stdout.write(JSON.stringify(result));
