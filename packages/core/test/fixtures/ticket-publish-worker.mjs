import fs from "node:fs";
import { GitFacade } from "../../dist/index.js";
import { GitTicketGenerationPublisherV0 } from "../../dist/git-ticket-store.js";

const [worktreeRoot, expectedSnapshotId, outcome, readyPath, gatePath] =
  process.argv.slice(2);
if (!worktreeRoot || !expectedSnapshotId || !outcome || !readyPath
  || !gatePath) {
  throw new Error(
    "usage: ticket-publish-worker <worktree> <expected> <outcome> <ready> <gate>",
  );
}
const session = GitFacade.sessionContextAt(worktreeRoot);
const scope = {
  repoId: 1,
  repositoryRoot: fs.realpathSync(session.repoRoot),
  worktreeRoot: fs.realpathSync(session.toplevel),
};
const definition = {
  schemaVersion: 1,
  kind: "ticket_definition_revision",
  ticketId: "TKT-001",
  definitionRevision: 2,
  created: {
    at: "2026-07-28T12:00:00.000Z",
    by: "agent:planner",
    reason: "Prepared by the Ticket shaping intelligence",
    source: { kind: "plan", ref: "plan:publisher-test" },
  },
  outcome,
  parentId: null,
  dependsOn: [],
  provenanceRefs: ["test:git-ticket-publisher"],
};

fs.writeFileSync(readyPath, "ready\n", { flag: "wx" });
const waitCell = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(gatePath)) Atomics.wait(waitCell, 0, 0, 5);

try {
  const result = new GitTicketGenerationPublisherV0().publish(scope, {
    expectedSnapshotId,
    definitions: [definition],
  });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: {
      code: error && typeof error === "object" && "code" in error
        ? error.code
        : "unknown",
      message: error instanceof Error ? error.message : String(error),
    },
  }));
}
