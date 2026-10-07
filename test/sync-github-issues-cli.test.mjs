import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { root, tempRepo, ticket } from "./helpers.mjs";
import { ALL_LABELS } from "../scripts/sync-github-issues.mjs";

const script = join(root, "scripts/sync-github-issues.mjs");
const fakeGh = String.raw`#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const path = process.env.VIBEHUB_TEST_REMOTE;
const state = JSON.parse(readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const endpoint = args[1];
const method = args[args.indexOf('--method') + 1];
const body = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined;
const url = new URL(endpoint, 'https://example.test/');
const route = url.pathname.replace(/^\/repos\/acme\/demo/, '');
const save = () => writeFileSync(path, JSON.stringify(state));
const emit = (value, pages = false) => {
  let requests = 1;
  if (pages) {
    const chunks = [];
    const count = args.includes('--paginate') ? value.length : Math.min(30, value.length);
    for (let i = 0; i < count; i += 100) chunks.push(value.slice(i, Math.min(i + 100, count)));
    if (!chunks.length) chunks.push([]);
    requests = chunks.length;
    value = args.includes('--slurp') ? chunks : chunks.flat();
  }
  if (method === 'GET') state.readRequests = (state.readRequests ?? 0) + requests;
  save();
  process.stdout.write(JSON.stringify(value));
};
state.calls.push({ method, endpoint });
const issueMatch = route.match(/^\/issues\/(\d+)(.*)$/);
const issue = issueMatch ? state.issues.find((item) => item.number === Number(issueMatch[1])) : null;
if (method === 'GET') {
  if (route === '') emit({ default_branch: state.branch ?? 'main' });
  else if (route.startsWith('/git/ref/heads/')) {
    state.headReads = (state.headReads ?? 0) + 1;
    emit({ object: { sha: state.changeHeadAt === state.headReads ? 'b'.repeat(40) : state.sha } });
  }
  else if (route === '/issues') emit(state.issues.map(({ comments, blockers, ...record }) => ({ ...record,
    ...(state.omitCounts ? {} : { comments: comments.length, issue_dependencies_summary: { total_blocked_by: blockers.length } }) })), true);
  else if (route === '/issues/comments') emit(state.issues.flatMap((item) => item.comments.map((comment) => ({ ...comment,
    issue_url: 'https://api.github.com/repos/acme/demo/issues/' + item.number }))), true);
  else if (route === '/labels') emit(state.labels, true);
  else if (issueMatch?.[2] === '/comments') emit(issue.comments ?? [], true);
  else if (issueMatch?.[2] === '/dependencies/blocked_by') emit(issue.blockers ?? [], true);
  else throw new Error('Unexpected read ' + endpoint);
} else {
  state.writes.push({ method, endpoint, body });
  const fail = state.failOnce === method + ' ' + route;
  if (fail) delete state.failOnce;
  let result = {};
  if (route === '/labels' && method === 'POST') state.labels.push(body);
  else if (route.startsWith('/labels/') && method === 'PATCH') Object.assign(state.labels.find((item) => item.name === decodeURIComponent(route.slice(8))), body);
  else if (route === '/issues' && method === 'POST') {
    const number = Math.max(0, ...state.issues.map((item) => item.number)) + 1;
    result = { number, id: number + 10000, title: body.title, body: body.body, state: 'open', labels: body.labels.map((name) => ({ name })), comments: [], blockers: [] };
    state.issues.push(result);
  } else if (issueMatch?.[2] === '' && method === 'PATCH') {
    if (state.concurrentLabels && body.body && issue.number === state.concurrentLabels.number) {
      issue.labels = issue.labels.filter((label) => label.name !== state.concurrentLabels.remove);
      issue.labels.push({ name: state.concurrentLabels.add });
      delete state.concurrentLabels;
    }
    if (state.dropUpdateOnce && body.body) delete state.dropUpdateOnce;
    else Object.assign(issue, body, ...(body.labels ? [{ labels: body.labels.map((name) => ({ name })) }] : []));
  } else if (issueMatch?.[2] === '/labels' && method === 'POST') {
    for (const name of body.labels) if (!issue.labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) issue.labels.push({ name });
  } else if (issueMatch?.[2].startsWith('/labels/') && method === 'DELETE') {
    const name = decodeURIComponent(issueMatch[2].slice(8));
    issue.labels = issue.labels.filter((label) => label.name.toLowerCase() !== name.toLowerCase());
  } else if (issueMatch?.[2] === '/comments' && method === 'POST') {
    result = { id: issue.comments.length + 1, body: body.body };
    issue.comments.push(result);
  } else if (issueMatch?.[2] === '/dependencies/blocked_by' && method === 'POST') {
    const blocker = state.issues.find((item) => item.id === body.issue_id);
    issue.blockers.push({ id: blocker.id, number: blocker.number });
  } else if (issueMatch?.[2].startsWith('/dependencies/blocked_by/') && method === 'DELETE') {
    const id = Number(issueMatch[2].split('/').at(-1));
    issue.blockers = issue.blockers.filter((item) => item.id !== id);
  } else throw new Error('Unexpected write ' + method + ' ' + endpoint);
  save();
  if (fail) { process.stderr.write('Connection lost after server accepted the write'); process.exit(1); }
  emit(result);
}
`;

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); }

function fixture(t, { empty = false, dependent = false, history = false } = {}) {
  const directory = tempRepo("issue-cli");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Issue test");
  git(repo, "config", "user.email", "test@example.test");
  writeFileSync(join(repo, "README.md"), "Shared project\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial source");
  const firstSha = git(repo, "rev-parse", "HEAD");
  if (!empty) {
    for (const name of ["tickets", "rooms", "evidence/ticket-alpha", "outcomes"]) mkdirSync(join(repo, ".vibehub", name), { recursive: true });
    writeJson(join(repo, ".vibehub/version.yaml"), { schema_version: 1, kind: "vibehub_project", format_version: 6 });
    const alpha = ticket("ticket-alpha");
    alpha.outcome = "Shared outcome";
    alpha.context = "Shared task background";
    alpha.status = dependent ? "done" : "open";
    if (history) {
      alpha.context_refs = [{ ref: `commit:${firstSha}:README.md`, purpose: "Original brief" }];
      rmSync(join(repo, "README.md"));
    }
    writeJson(join(repo, ".vibehub/tickets/ticket-alpha.yaml"), alpha);
    writeJson(join(repo, ".vibehub/evidence/ticket-alpha/proof.yaml"), {
      schema_version: 2, kind: "ticket_evidence", evidence_id: "proof", ticket_id: alpha.ticket_id,
      binding_state: "bound", binding_origin: "native", acceptance_ids: ["works"],
      acceptance_revisions: [alpha.contract_revisions[0].acceptance_revisions[0]],
      summary: "Shared proof", refs: ["test:shared-proof"], recorded_at: "2026-10-06T00:00:00Z",
    });
    if (dependent) {
      const beta = ticket("ticket-beta");
      beta.relations = [{ type: "depends_on", target_ticket_id: alpha.ticket_id, rationale: "Needs alpha" }];
      writeJson(join(repo, ".vibehub/tickets/ticket-beta.yaml"), beta);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "shared records");
  }
  const sha = git(repo, "rev-parse", "HEAD");
  const remote = join(directory, "remote.json");
  writeJson(remote, { sha, labels: ALL_LABELS, issues: [], calls: [], writes: [] });
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  const state = () => JSON.parse(readFileSync(remote, "utf8"));
  const changeRemote = (update) => { const current = state(); update(current); writeJson(remote, current); };
  const run = (...args) => {
    const reportPath = join(directory, "report.json");
    rmSync(reportPath, { force: true });
    const result = spawnSync(process.execPath, [script, "--repo", repo, "--report", reportPath, ...args], {
      encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VIBEHUB_TEST_REMOTE: remote },
      timeout: 90000,
    });
    let report;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch {}
    return { ...result, report };
  };
  return { repo, sha, state, changeRemote, run };
}

const publish = ["--publish", "--github", "acme/demo", "--ref", "HEAD"];
const preview = ["--dry-run", "--github", "acme/demo", "--ref", "HEAD"];

function mirrored(number = 1, id = "ticket-alpha") {
  return { number, id: number + 10000, title: "Alpha", body: `<!-- vibehub:ticket-id=${id} -->`,
    state: "open", labels: [{ name: "state: open" }], comments: [], blockers: [] };
}

test("offline CLI reads committed records and historical refs, excluding every kind of local change", (t) => {
  const f = fixture(t, { history: true });
  const alphaPath = join(f.repo, ".vibehub/tickets/ticket-alpha.yaml");
  const alpha = JSON.parse(readFileSync(alphaPath, "utf8"));
  alpha.outcome = "PRIVATE staged edit";
  writeJson(alphaPath, alpha);
  git(f.repo, "add", alphaPath);
  alpha.outcome = "PRIVATE dirty edit";
  writeJson(alphaPath, alpha);
  writeFileSync(join(f.repo, ".gitignore"), "ignored.yaml\n");
  writeFileSync(join(f.repo, ".vibehub/tickets/ignored.yaml"), "PRIVATE ignored invalid record");
  writeFileSync(join(f.repo, ".vibehub/tickets/untracked.yaml"), "PRIVATE untracked invalid record");
  const before = git(f.repo, "status", "--porcelain");
  const result = f.run("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.status, "validated");
  assert.equal(result.report.tickets, 1);
  assert.equal(result.report.source.sha, f.sha);
  assert.equal(f.state().calls.length, 0);
  assert.equal(git(f.repo, "status", "--porcelain"), before);
  assert.equal(JSON.parse(readFileSync(alphaPath, "utf8")).outcome, "PRIVATE dirty edit");
  const remotePlan = f.run(...preview);
  assert.equal(remotePlan.status, 0, remotePlan.stderr);
  assert.deepEqual(remotePlan.report.planned.map((op) => op.kind), ["create", "update", "comment"]);
  assert.doesNotMatch(JSON.stringify(remotePlan.report), /PRIVATE|Shared proof|Shared task background/);
});

test("no committed project is no work; a partial or corrupt project produces exact diagnostics", (t) => {
  const f = fixture(t, { empty: true });
  const empty = f.run("--check");
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.report.status, "no-shared-project");
  mkdirSync(join(f.repo, ".vibehub"));
  writeFileSync(join(f.repo, ".vibehub/version.yaml"), "invalid JSON");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "broken marker");
  const invalid = f.run("--check");
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /\.vibehub\/version.yaml/);
  assert.match(invalid.stderr, /invalid|JSON/i);
  assert.equal(invalid.report.status, "failed");
  rmSync(join(f.repo, ".vibehub/version.yaml"));
  mkdirSync(join(f.repo, ".vibehub/tickets"));
  writeJson(join(f.repo, ".vibehub/tickets/orphan.yaml"), ticket("orphan"));
  git(f.repo, "add", "-A"); git(f.repo, "commit", "-qm", "partial project");
  assert.match(f.run("--check").stderr, /\.vibehub\/version.yaml.*MIGRATION_REQUIRED/);
  assert.equal(f.state().calls.length, 0);
});

test("remote pages beyond 1000 Issues and 100 comments retain marker identity", (t) => {
  const f = fixture(t);
  f.changeRemote((state) => {
    state.labels.unshift(...Array.from({ length: 105 }, (_, index) => ({ name: `foreign-${index}`, color: "ffffff", description: "unmanaged" })));
    state.issues = Array.from({ length: 1001 }, (_, index) => ({ ...mirrored(index + 2), body: "Ordinary inbound issue" }));
    const oldest = mirrored(1);
    oldest.comments = Array.from({ length: 130 }, (_, index) => ({ id: index, body: `Discussion ${index}` }));
    oldest.comments[110].body = "<!-- vibehub:evidence-id=proof -->\nPrior proof";
    oldest.blockers = Array.from({ length: 120 }, (_, index) => ({ number: index + 2000, id: index + 90000 }));
    state.issues.push(oldest, { ...mirrored(2000), pull_request: { url: "https://example.test/pr" } });
  });
  const result = f.run(...preview);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.issues, 1002);
  assert.deepEqual(result.report.planned, [{ kind: "update", ticket_id: "ticket-alpha", number: 1 }]);
  assert.equal(result.report.changed_evidence[0].evidence_id, "proof");
  assert.equal(f.state().writes.length, 0);
});

test("duplicate Ticket and Evidence markers stop before any publication", (t) => {
  const f = fixture(t);
  f.changeRemote((state) => { state.issues = [mirrored(1), mirrored(2)]; state.labels = []; });
  const duplicate = f.run(...publish);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Duplicate Ticket marker ticket-alpha.*#1.*#2/);
  f.changeRemote((state) => {
    state.issues = [mirrored(1)];
    state.issues[0].comments = [1, 2].map((id) => ({ id, body: "<!-- vibehub:evidence-id=proof -->" }));
  });
  assert.match(f.run(...publish).stderr, /Duplicate Evidence marker proof/);
  assert.equal(f.state().writes.length, 0);
});

test("publication converges, preserves concurrent foreign labels, and a later unchanged-source projection performs zero writes", (t) => {
  const f = fixture(t, { dependent: true });
  f.changeRemote((state) => {
    state.labels.find((label) => label.name === "state: done").color = "ffffff";
    state.concurrentLabels = { number: 1, add: "human-added", remove: "bug" };
    const alpha = mirrored(1);
    alpha.labels.push({ name: "bug" });
    alpha.comments.push({ id: 1, body: "Keep this discussion" });
    const beta = mirrored(2, "ticket-beta");
    beta.blockers = [{ number: 1, id: 999999 }];
    state.issues = [alpha, beta, mirrored(3, "retired-ticket"), { ...mirrored(4), body: "Inbound proposal", title: "Do not adopt" }];
  });
  const result = f.run(...publish);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.status, "converged");
  assert.equal(result.report.writes, 8);
  assert.equal(result.report.remaining.length, 0);
  assert.deepEqual(result.report.orphans, [{ ticket_id: "retired-ticket", number: 3 }]);
  const state = f.state();
  const alpha = state.issues[0];
  assert.equal(alpha.state, "closed");
  assert.match(alpha.body, /## Background\n\nShared task background/);
  assert.deepEqual(alpha.labels.map((label) => label.name).sort(), ["human-added", "state: done"]);
  assert.equal(alpha.comments[0].body, "Keep this discussion");
  assert.equal(alpha.comments.filter((comment) => comment.body.includes("vibehub:evidence-id=proof")).length, 1);
  assert.deepEqual(state.issues[1].blockers, [{ number: 1, id: 999999 }, { number: 1, id: 10001 }]);
  assert.equal(state.issues[3].title, "Do not adopt");
  assert.equal(state.labels.find((label) => label.name === "state: done").color, "8250df");
  const bodies = state.issues.map((issue) => issue.body);
  writeFileSync(join(f.repo, "unrelated.txt"), "New code, unchanged records\n");
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "unrelated code");
  f.changeRemote((remote) => {
    remote.sha = git(f.repo, "rev-parse", "HEAD");
    remote.labels.find((label) => label.name === "state: done").name = "State: Done";
    remote.issues[0].labels.find((label) => label.name === "state: done").name = "State: Done";
  });
  const repeated = f.run(...publish);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.report.status, "converged");
  assert.equal(repeated.report.writes, 0);
  assert.equal(f.state().writes.length, result.report.writes);
  assert.deepEqual(f.state().issues.map((issue) => issue.body), bodies);
  const repeatedCalls = f.state().calls.slice(state.calls.length);
  assert.equal(repeatedCalls.filter((call) => call.endpoint === "repos/acme/demo/issues?state=all&per_page=100").length, 1);
  assert.equal(repeatedCalls.filter((call) => call.endpoint.includes("/git/ref/heads/")).length, 2);
});

test("remote read budget uses repository comment pages and skips only known-empty relationships", (t) => {
  const f = fixture(t);
  const initial = f.run(...publish);
  assert.equal(initial.status, 0, initial.stderr);
  const first = f.state();
  assert.equal(first.calls.filter((call) => call.method === "GET" && call.endpoint.includes("/dependencies/")).length, 0);
  assert.equal(first.calls.filter((call) => call.method === "GET" && call.endpoint.includes("/issues/comments?")).length, 1);
  f.changeRemote((state) => { state.omitCounts = true; });
  const fallback = f.run(...preview);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(fallback.report.planned.length, 0);
  const fallbackCalls = f.state().calls.slice(first.calls.length);
  assert.equal(fallbackCalls.filter((call) => call.endpoint.includes("/dependencies/")).length, 1);
  assert.equal(fallbackCalls.filter((call) => call.endpoint.includes("/issues/comments?")).length, 1);
  f.changeRemote((state) => {
    delete state.omitCounts;
    for (let index = 0; index < 129; index += 1) {
      const issue = mirrored(index + 2, `archived-${index}`);
      issue.comments = [{ id: index + 2, body: "Retained discussion" }];
      if (index < 60) issue.blockers = [{ number: 9000, id: 99000 }];
      state.issues.push(issue);
    }
  });
  const before = f.state();
  const repeated = f.run(...publish);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(repeated.report.status, "converged");
  assert.equal(repeated.report.writes, 0);
  const after = f.state();
  assert.equal(after.readRequests - before.readRequests, 69);
  assert.equal(after.calls.slice(before.calls.length).filter((call) => call.endpoint.includes("/issues/comments?")).length, 1);
});

test("an ambiguous create stops once and a fresh invocation adopts its marker", (t) => {
  const f = fixture(t);
  f.changeRemote((state) => { state.failOnce = "POST /issues"; });
  const failed = f.run(...publish);
  assert.equal(failed.status, 1);
  assert.equal(failed.report.failed_operation.kind, "create");
  assert.deepEqual(failed.report.remaining.map((op) => op.kind), ["create", "update", "comment"]);
  assert.equal(f.state().writes.length, 1);
  assert.equal(f.state().issues.length, 1);
  const retried = f.run(...publish);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(retried.report.status, "converged");
  assert.equal(retried.report.writes, 2);
  assert.equal(f.state().issues.length, 1);
  assert.equal(f.state().issues[0].comments.length, 1);
  assert.equal(f.state().writes.filter((write) => write.method === "POST" && write.endpoint.endsWith("/issues")).length, 1);
});

test("post-write verification rejects an acknowledged but missing body update", (t) => {
  const f = fixture(t);
  f.changeRemote((state) => { state.dropUpdateOnce = true; });
  const result = f.run(...publish);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Post-write verification failed/);
  assert.equal(result.report.converged, false);
  assert.deepEqual(result.report.remaining, [{ kind: "update", ticket_id: "ticket-alpha", number: 1 }]);
});

test("canonical-head checks reject branch publication and report a source superseded before writes", (t) => {
  const f = fixture(t);
  f.changeRemote((state) => { state.sha = "a".repeat(40); });
  const wrong = f.run(...publish);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not the current main commit/);
  f.changeRemote((state) => { state.sha = f.sha; state.headReads = 0; state.changeHeadAt = 2; });
  const moved = f.run(...publish);
  assert.equal(moved.status, 0, moved.stderr);
  assert.equal(moved.report.status, "superseded");
  assert.equal(moved.report.converged, false);
  assert.equal(f.state().writes.length, 0);
});


test("quoted marker examples in task and Evidence prose never become remote identities", (t) => {
  const f = fixture(t);
  const path = join(f.repo, ".vibehub/tickets/ticket-alpha.yaml");
  const record = JSON.parse(readFileSync(path, "utf8"));
  record.outcome = "Document <!-- vibehub:ticket-id=example --> safely";
  record.context = "Example header:\n<!-- vibehub:ticket-id=quoted-ticket -->";
  writeJson(path, record);
  const evidencePath = join(f.repo, ".vibehub/evidence/ticket-alpha/proof.yaml");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  evidence.summary = "Example header:\n<!-- vibehub:evidence-id=quoted-evidence -->";
  writeJson(evidencePath, evidence);
  git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "document marker examples");
  f.changeRemote((state) => { state.sha = git(f.repo, "rev-parse", "HEAD"); });
  const first = f.run(...publish);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.report.status, "converged");
  assert.match(f.state().issues[0].body, /quoted-ticket/);
  assert.match(f.state().issues[0].comments[0].body, /quoted-evidence/);
  const second = f.run(...publish);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.report.writes, 0);
  assert.equal(f.state().issues.length, 1);
  assert.equal(f.state().issues[0].comments.length, 1);
});
