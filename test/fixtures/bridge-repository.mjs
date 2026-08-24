// A bound VibeHub repository for Chat bridge proofs, committed as a whole so
// everything a bridge action writes afterwards is visibly uncommitted: one Room
// with a nested Room and an active Context, one open firm Ticket that depends
// on one Ticket closed by a successful Outcome. The browser guard boots the
// production launcher on a copy of this repository instead of the checkout it
// lives in, so no proof ever writes into a real .vibehub tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contractIdentity } from "../../skills/vibehub-core/scripts/vh.mjs";

export function git(cwd, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// Untrimmed on purpose: a tracked change's two-column status starts with a space.
export function porcelain(cwd, extra = []) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "status", "--porcelain", "--untracked-files=all", ...extra], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean);
}

export const commitCount = (cwd) => git(cwd, ["rev-list", "--count", "HEAD"]);

// The fixture is a binding-aware (format 3) repository, so its proof carries
// the native bindings every vh.mjs write produces there: without them a
// successful Outcome is unresolved by design and the closed Task would
// return as REPLAN work instead of staying closed.
const CLOSED_IDENTITY = contractIdentity({
  ticket_id: "ticket-bridge-closed",
  acceptance: [{ acceptance_id: "closed-holds", criterion: "The closed Task holds." }],
});

export const BRIDGE_REPOSITORY_DOCUMENTS = Object.freeze({
  ".vibehub/version.yaml": { format_version: 3, kind: "vibehub_project", schema_version: 1 },
  ".vibehub/rooms/product/room.yaml": { schema_version: 1, kind: "room", room_id: "product", description: "Product direction", boundary: "What the shell promises", anchors: ["README.md"], stale: false },
  ".vibehub/rooms/product/ux/room.yaml": { schema_version: 1, kind: "room", room_id: "ux", description: "Interaction detail", boundary: "How the shell behaves", anchors: ["README.md"], stale: false },
  ".vibehub/rooms/product/decision-bridge-direction.yaml": {
    schema_version: 1, kind: "context", context_id: "decision-bridge-direction", type: "decision", state: "active",
    summary: "Codex Chat stays continuous and births Tasks explicitly", detail: "A Task is born only through an explicit Create Task confirmation.", tags: ["bridge", "codex"],
    source: { ref: "conversation:bridge-direction", captured_at: "2026-08-21T10:00:00Z" },
    evidence: [{ ref: "conversation:bridge-direction", note: "Owner decision." }], relations: [],
  },
  ".vibehub/tickets/ticket-bridge-open.yaml": {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-bridge-open", maturity: "firm", outcome: "The open Task accepts Codex Chat associations.", deliveries: [],
    context: "Stays open.", acceptance: [{ acceptance_id: "open-holds", criterion: "The open Task holds." }], constraints: ["No second store."],
    context_refs: [{ ref: ".vibehub/rooms/product/decision-bridge-direction.yaml", purpose: "Binding direction." }],
    relations: [{ type: "depends_on", target_ticket_id: "ticket-bridge-closed", rationale: "The closed Task proved the ground the open one builds on." }],
    provenance_refs: ["conversation:bridge-direction"],
  },
  ".vibehub/tickets/ticket-bridge-closed.yaml": {
    schema_version: 2, kind: "ticket", ticket_id: "ticket-bridge-closed", maturity: "firm", outcome: "The closed Task is accepted.", deliveries: [],
    context: "Closed.", acceptance: [{ acceptance_id: "closed-holds", criterion: "The closed Task holds." }], constraints: [], context_refs: [], relations: [], provenance_refs: [],
  },
  ".vibehub/evidence/ticket-bridge-closed/closed-proof.yaml": { schema_version: 2, kind: "ticket_evidence", evidence_id: "closed-proof", ticket_id: "ticket-bridge-closed", acceptance_ids: ["closed-holds"], acceptance_bindings: [{ acceptance_id: "closed-holds", digest: CLOSED_IDENTITY.criterion_digests["closed-holds"], binding: "native" }], summary: "Closed proven.", refs: ["README.md"], origin: "agent", recorded_at: "2026-08-20T11:00:00Z" },
  ".vibehub/outcomes/ticket-bridge-closed.yaml": { schema_version: 2, kind: "ticket_outcome", ticket_id: "ticket-bridge-closed", status: "successful", accepted_acceptance_ids: ["closed-holds"], unresolved_acceptance_ids: [], evidence_ids: ["closed-proof"], contract_binding: { digest: CLOSED_IDENTITY.contract_digest, binding: "native" }, summary: "Independently accepted.", closed_at: "2026-08-20T12:00:00Z" },
});

export function createBridgeRepository({ prefix = "vibehub-bridge-guard-" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(folder, "README.md"), "# bridge fixture\n");
  git(folder, ["init", "-q", "-b", "main"]);
  git(folder, ["config", "user.email", "fixture@example.com"]);
  git(folder, ["config", "user.name", "Fixture"]);
  git(folder, ["add", "README.md"]);
  git(folder, ["commit", "-q", "-m", "fixture"]);
  for (const [path, document] of Object.entries(BRIDGE_REPOSITORY_DOCUMENTS)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), `${JSON.stringify(document, null, 2)}\n`);
  }
  git(folder, ["add", ".vibehub"]);
  git(folder, ["commit", "-q", "-m", "vibehub bridge graph"]);
  return { folder, realFolder: realpathSync.native(folder), commits: commitCount(folder) };
}

// Back to the committed graph: every uncommitted bridge write is discarded so
// the next proof starts from the same checked-in state.
export function resetBridgeRepository(folder) {
  git(folder, ["checkout", "-q", "--", "."]);
  git(folder, ["clean", "-qfd", "--", ".vibehub"]);
  return porcelain(folder);
}
