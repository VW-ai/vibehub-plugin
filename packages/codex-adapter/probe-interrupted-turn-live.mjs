#!/usr/bin/env node

// Observe what the real app-server reports for a Turn that was in progress
// when the process died. The fixture app-server keeps the persisted
// `inProgress` status for such a Turn (the strictest case); this probe reads
// the truth from the pinned binary so the fixture can mirror it.
//
// One persistent read-only Thread in this cwd gets a Turn that runs a long
// read-only command; once the command item has started, the app-server is
// SIGKILLed under it. A second process then lists the folder, reads the
// Thread before and after thread/resume, and deletes it.

import { execFileSync } from "node:child_process";
import { CodexAppServerClient } from "./client.mjs";

const cwd = process.cwd();
const name = "VibeHub interrupted-Turn probe";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The npm `codex` launcher is a Node wrapper around the native app-server
// binary; the process that owns the Thread is the deepest descendant. Killing
// that one is the faithful "the app-server died" case, and the wrapper then
// exits on its own, which is what the client observes.
function appServerProcessTree(pid) {
  const tree = [pid];
  let current = pid;
  for (;;) {
    let children = [];
    try {
      children = execFileSync("pgrep", ["-P", String(current)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      children = [];
    }
    if (children.length !== 1) return tree;
    current = children[0];
    tree.push(current);
  }
}

async function list(client) {
  return client.request("thread/list", { archived: false, cursor: null, cwd, limit: 100, searchTerm: null, sortDirection: "desc", sortKey: "updated_at" });
}

function turnView(thread, turnId) {
  const turn = (thread.turns ?? []).find((entry) => entry.id === turnId) ?? null;
  return {
    threadStatus: thread.status,
    turnFound: Boolean(turn),
    turnStatus: turn?.status ?? null,
    turnError: turn?.error ?? null,
    itemTypes: (turn?.items ?? []).map((item) => `${item.type}:${item.status ?? "-"}`),
  };
}

async function main() {
  let first = null;
  let second = null;
  let threadId = null;
  try {
    first = new CodexAppServerClient({ cwd, timeoutMs: 90_000 });
    const initialized = await first.start();
    for (const thread of (await list(first)).data ?? []) {
      if (thread.name === name) await first.request("thread/delete", { threadId: thread.id });
    }
    const started = await first.request("thread/start", { approvalPolicy: "never", cwd, ephemeral: false, sandbox: "read-only" });
    threadId = started.thread.id;
    await first.request("thread/name/set", { threadId, name });
    const commandStarted = first.waitForNotification("item/started", (params) => params?.threadId === threadId && params?.item?.type === "commandExecution");
    const turnStarted = first.waitForNotification("turn/started", (params) => params?.threadId === threadId);
    await first.request("turn/start", { threadId, input: [{ type: "text", text: "Use the shell to run exactly `sleep 90` and nothing else, then reply with exactly SLEEP-DONE. Do not inspect or modify any file." }] });
    const turnId = (await turnStarted).turn.id;
    const command = await commandStarted;
    const live = await first.request("thread/read", { threadId, includeTurns: true });
    const before = turnView(live.thread, turnId);
    const tree = appServerProcessTree(first.child.pid);
    const pid = tree.at(-1);
    const exited = new Promise((resolve) => first.once("exit", resolve));
    const killedAt = Date.now();
    process.kill(pid, "SIGKILL");
    const exit = await exited;
    while (tree.some(isAlive) && Date.now() - killedAt < 5_000) await new Promise((resolve) => setTimeout(resolve, 25));
    const treeGoneAfterMs = tree.some(isAlive) ? null : Date.now() - killedAt;

    second = new CodexAppServerClient({ cwd, timeoutMs: 60_000 });
    await second.start();
    const listed = ((await list(second)).data ?? []).find((thread) => thread.id === threadId) ?? null;
    const replayBeforeResume = await second.request("thread/read", { threadId, includeTurns: true });
    await second.request("thread/resume", { threadId, approvalPolicy: "never", cwd, sandbox: "read-only" });
    const replayAfterResume = await second.request("thread/read", { threadId, includeTurns: true });
    await second.request("thread/delete", { threadId });
    threadId = null;

    process.stdout.write(`${JSON.stringify({
      ok: true,
      runtime: { userAgent: initialized.userAgent, processTree: tree, killedPid: pid },
      threadId: replayBeforeResume.thread.id,
      turnId,
      commandItem: { id: command.item.id, command: command.item.command ?? null },
      beforeKill: before,
      kill: { signal: exit.signal, code: exit.code, requested: exit.requested, treeGoneAfterMs },
      afterRestart: {
        listedInFolder: Boolean(listed),
        listedStatus: listed?.status ?? null,
        beforeResume: turnView(replayBeforeResume.thread, turnId),
        afterResume: turnView(replayAfterResume.thread, turnId),
      },
      cleanedUp: true,
    }, null, 2)}\n`);
  } finally {
    if (threadId && second?.alive) await second.request("thread/delete", { threadId }).catch(() => {});
    await second?.stop();
    await first?.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
