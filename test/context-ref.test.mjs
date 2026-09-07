import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  parseTicketContextRef,
  resolveTicketContextRef,
} from "../skills/vibehub-core/scripts/vh.mjs";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const repo = tempRepo("context-ref");
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "history.txt"), "historical bytes\n");
  writeFileSync(join(repo, "docs", "current.txt"), "current bytes\n");
  symlinkSync("history.txt", join(repo, "docs", "link"));
  git(repo, "init");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "historical fixture");
  const historicalCommit = git(repo, "rev-parse", "HEAD");
  const historicalBlob = git(repo, "rev-parse", `${historicalCommit}:docs/history.txt`);

  unlinkSync(join(repo, "docs", "history.txt"));
  unlinkSync(join(repo, "docs", "link"));
  git(repo, "add", "-u");
  git(repo, "update-index", "--add", "--cacheinfo", `160000,${historicalCommit},vendor/sub`);
  git(repo, "commit", "-m", "delete historical source and add gitlink");
  const gitlinkCommit = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "docs", "current.txt"), "dirty current bytes\n");
  writeFileSync(join(repo, "untracked.txt"), "leave me alone\n");
  return { repo, historicalCommit, historicalBlob, gitlinkCommit };
}

test("one parser owns current and immutable versioned Ticket context refs", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseTicketContextRef("docs/current.txt"), {
    kind: "current", ref: "docs/current.txt", commit: null, path: "docs/current.txt",
  });
  assert.deepEqual(parseTicketContextRef(`commit:${sha}:docs/history.txt`), {
    kind: "versioned", ref: `commit:${sha}:docs/history.txt`, commit: sha, path: "docs/history.txt",
  });
  for (const ref of [
    "commit:abc:docs/file.txt",
    `commit:${"A".repeat(40)}:docs/file.txt`,
    `commit:${sha}:`,
    `commit:${sha}:/absolute.txt`,
    `commit:${sha}:../outside.txt`,
    `commit:${sha}:docs/../outside.txt`,
    `commit:${sha}:docs//file.txt`,
    `commit:${sha}:docs\\file.txt`,
    "/absolute.txt",
    "../outside.txt",
    "docs/./file.txt",
  ]) {
    assert.throws(() => parseTicketContextRef(ref), (error) => error.code === "invalid_context_ref", ref);
  }
});

test("context resolve returns exact historical bytes and machine-readable object errors", () => {
  const { repo, historicalCommit, historicalBlob, gitlinkCommit } = fixture();
  const ref = `commit:${historicalCommit}:docs/history.txt`;
  const resolved = run(repo, "context", "resolve", { ref });
  assert.equal(resolved.status, 0, resolved.stdout);
  assert.deepEqual(resolved.envelope.data.identity, {
    commit: historicalCommit,
    path: "docs/history.txt",
    blob: historicalBlob,
  });
  assert.equal(resolved.envelope.data.kind, "versioned");
  assert.equal(resolved.envelope.data.source, "historical bytes\n");
  assert.equal(Buffer.from(resolved.envelope.data.source_base64, "base64").toString(), "historical bytes\n");

  const current = run(repo, "context", "resolve", { ref: "docs/current.txt" });
  assert.equal(current.status, 0, current.stdout);
  assert.equal(current.envelope.data.kind, "current");
  assert.equal(current.envelope.data.identity.revision, "WORKTREE");
  assert.equal(current.envelope.data.source, "dirty current bytes\n");

  const cases = [
    [`commit:${"f".repeat(40)}:docs/history.txt`, "context_ref_missing_commit"],
    [`commit:${historicalBlob}:docs/history.txt`, "context_ref_not_commit"],
    [`commit:${historicalCommit}:docs/missing.txt`, "context_ref_missing_path"],
    [`commit:${historicalCommit}:docs`, "context_ref_directory"],
    [`commit:${historicalCommit}:docs/link`, "context_ref_symlink"],
    [`commit:${gitlinkCommit}:vendor/sub`, "context_ref_submodule"],
  ];
  for (const [candidate, code] of cases) {
    const result = run(repo, "context", "resolve", { ref: candidate });
    assert.notEqual(result.status, 0, candidate);
    assert.equal(result.envelope.error.code, code, candidate);
  }
});

test("historical resolution is Git-object-only and leaves dirty worktrees invariant", () => {
  const { repo, historicalCommit } = fixture();
  const sibling = `${repo}-sibling`;
  git(repo, "worktree", "add", "-b", "sibling", sibling);
  writeFileSync(join(sibling, "docs", "history.txt"), "different sibling branch bytes\n");
  git(sibling, "add", "docs/history.txt");
  git(sibling, "commit", "-m", "different sibling source");
  const before = {
    head: git(repo, "rev-parse", "HEAD"),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    index: readFileSync(join(repo, ".git", "index")),
    current: readFileSync(join(repo, "docs", "current.txt")),
    untracked: readFileSync(join(repo, "untracked.txt")),
  };
  const direct = resolveTicketContextRef(repo, `commit:${historicalCommit}:docs/history.txt`);
  assert.equal(direct.source, "historical bytes\n");
  const fromSibling = resolveTicketContextRef(sibling, `commit:${historicalCommit}:docs/history.txt`);
  assert.deepEqual(fromSibling.identity, direct.identity);
  assert.equal(fromSibling.source_base64, direct.source_base64);
  assert.equal(git(repo, "rev-parse", "HEAD"), before.head);
  assert.equal(git(repo, "status", "--porcelain=v1", "--untracked-files=all"), before.status);
  assert.deepEqual(readFileSync(join(repo, ".git", "index")), before.index);
  assert.deepEqual(readFileSync(join(repo, "docs", "current.txt")), before.current);
  assert.deepEqual(readFileSync(join(repo, "untracked.txt")), before.untracked);
});

test("Ticket validation resolves historical refs instead of accepting syntax alone", () => {
  const { repo, historicalCommit } = fixture();
  const valid = ticket("historical-reader");
  valid.context_refs = [{
    ref: `commit:${historicalCommit}:docs/history.txt`,
    purpose: "Exact deleted source.",
  }];
  assert.equal(run(repo, "ticket", "apply", {
    validation: { independent: false, note: "test fixture" },
    tickets: [valid],
  }).status, 0);

  const invalid = ticket("missing-history");
  invalid.context_refs = [{
    ref: `commit:${historicalCommit}:docs/missing.txt`,
    purpose: "Missing source.",
  }];
  const result = run(repo, "ticket", "apply", {
    validation: { independent: false, note: "test fixture" },
    tickets: [invalid],
  });
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.envelope.error.details), /path is absent/u);
});

test("all ten marketplace deleted-path workarounds bind to their exact reviewed blobs", () => {
  const beforeRetirement = "f371bf64d02fc4deb17568402eeb42af27af2302";
  const partialCloseout = "33de83c2526258a48340863ab752d45ff7b56140";
  const expected = [
    ["ticket-focus-product-on-one-line-entry", ".codex-plugin/plugin.json", beforeRetirement, "fe3c2ab51e06f5abfde3924a09ffaa89c373b4f4"],
    ["ticket-implement-npx-first-install-experience", ".codex-plugin/plugin.json", beforeRetirement, "fe3c2ab51e06f5abfde3924a09ffaa89c373b4f4"],
    ["ticket-prepare-v040-release", ".codex-plugin/plugin.json", beforeRetirement, "fe3c2ab51e06f5abfde3924a09ffaa89c373b4f4"],
    ["ticket-prepare-v040-release", ".claude-plugin/marketplace.json", beforeRetirement, "ce49d4c15576e034692d6433800c7cdb24a844d1"],
    ["ticket-prepare-v060-release", "test/host-marketplaces.test.mjs", beforeRetirement, "96367743815cbf25443574bf2c50d27e8b53c8ae"],
    ["ticket-vibehub-cli", "test/host-marketplaces.test.mjs", beforeRetirement, "96367743815cbf25443574bf2c50d27e8b53c8ae"],
    ["ticket-retire-marketplace-distribution", "scripts/build-claude-marketplace.mjs", beforeRetirement, "c871a60e80d490f80e2a4314d835f2f0692f8ba0"],
    ["ticket-retire-marketplace-distribution", "scripts/build-codex-marketplace.mjs", beforeRetirement, "a367e911315c5c073d9f1389eeed7bd1c2e2442f"],
    ["ticket-retire-marketplace-distribution", "test/host-marketplaces.test.mjs", beforeRetirement, "96367743815cbf25443574bf2c50d27e8b53c8ae"],
    ["ticket-retire-marketplace-distribution", ".agents/plugins/marketplace.json", partialCloseout, "498219b5ddeca112b88c475c9f92b47e45399604"],
  ];

  const ticketRoot = join(root, ".vibehub", "tickets");
  const tickets = new Map();
  for (const name of readdirSync(ticketRoot).filter((item) => item.endsWith(".yaml")).sort()) {
    const document = JSON.parse(readFileSync(join(ticketRoot, name), "utf8"));
    tickets.set(document.ticket_id, document);
    assert.equal(document.provenance_refs.some((ref) => ref.startsWith("deleted-path:")), false, document.ticket_id);
  }
  const versioned = [...tickets.values()].flatMap((document) => document.context_refs
    .filter(({ ref }) => ref.startsWith("commit:"))
    .map(({ ref }) => [document.ticket_id, ref]));
  assert.equal(versioned.length, expected.length);
  assert.equal(git(root, "rev-parse", "9425e0c^"), beforeRetirement);

  for (const [ticketId, path, commit, blob] of expected) {
    const ref = `commit:${commit}:${path}`;
    const document = tickets.get(ticketId);
    assert.ok(document.context_refs.some((item) => item.ref === ref), `${ticketId} missing ${ref}`);
    assert.deepEqual(resolveTicketContextRef(root, ref).identity, { commit, path, blob });
    const deletion = path === ".agents/plugins/marketplace.json" ? "594599e" : "9425e0c";
    assert.match(git(root, "diff-tree", "--no-commit-id", "--name-status", "-r", deletion, "--", path), /^D\s/u);
    if (ticketId !== "ticket-retire-marketplace-distribution") {
      const historicalTicket = JSON.parse(git(root, "show", `${beforeRetirement}:.vibehub/tickets/${ticketId}.yaml`));
      assert.ok(historicalTicket.context_refs.some((item) => item.ref === path), `${ticketId} did not cite ${path} before retirement`);
    }
  }
  const retirementTicket = JSON.parse(git(root, "show", "9425e0c:.vibehub/tickets/ticket-retire-marketplace-distribution.yaml"));
  for (const path of expected.filter(([id, , commit]) => id === "ticket-retire-marketplace-distribution" && commit === beforeRetirement).map(([, path]) => path)) {
    assert.ok(retirementTicket.provenance_refs.includes(`deleted-path:${path}`));
  }
  const partial = JSON.parse(git(root, "show", `${partialCloseout}:.vibehub/outcomes/ticket-retire-marketplace-distribution.yaml`));
  assert.match(partial.summary, /\.agents\/plugins\/marketplace\.json/u);
});
