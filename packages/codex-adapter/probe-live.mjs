#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerClient } from "./client.mjs";
import { startCodexTask } from "./handoff.mjs";
import { buildTicketHandoff } from "../../skills/vibehub-core/scripts/vh-ui.mjs";

const cwd = process.cwd();
const sentinel = "VIBEHUB_CODEX_ADAPTER_OK";

function syntheticHandoff() {
  const repo = mkdtempSync(join(tmpdir(), "vibehub-codex-handoff-"));
  const vh = resolve(cwd, "skills/vibehub-core/scripts/vh.mjs");
  const input = join(repo, "ticket.json");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync(process.execPath, [vh, "project", "init", "--repo", repo]);
  writeFileSync(input, `${JSON.stringify({
    tickets: [{
      schema_version: 2,
      kind: "ticket",
      ticket_id: "ticket-codex-transport-probe",
      maturity: "firm",
      outcome: "A synthetic non-sensitive handoff reaches one Codex Turn unchanged.",
      context: "Synthetic protocol fixture with no private repository content.",
      acceptance: [{
        acceptance_id: "transport-is-exact",
        criterion: "The host-owned payload is transported without browser reconstruction.",
      }],
      constraints: ["Do not perform repository work; this is a transport fixture."],
      context_refs: [],
      relations: [],
      provenance_refs: ["probe:synthetic-non-sensitive"],
      deliveries: [],
    }],
  }, null, 2)}\n`);
  execFileSync(process.execPath, [vh, "ticket", "apply", "--repo", repo, "--input", input]);
  try {
    return buildTicketHandoff(repo, "ticket-codex-transport-probe");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

async function listThreads(client) {
  return client.request("thread/list", {
    archived: false,
    cursor: null,
    cwd,
    limit: 40,
    searchTerm: null,
    sortDirection: "desc",
    sortKey: "updated_at",
  });
}

async function main() {
  const first = new CodexAppServerClient({ cwd, timeoutMs: 90_000 });
  await first.start();
  const account = await first.accountStatus();
  const before = await listThreads(first);
  const stableThreadId = before.data?.[0]?.id ?? before.threads?.[0]?.id ?? null;
  if (!stableThreadId) throw new Error("no stable Codex Thread exists for restart recovery probe");

  const started = await first.request("thread/start", {
    approvalPolicy: "never",
    cwd,
    ephemeral: true,
    sandbox: "read-only",
  });
  const ephemeralThreadId = started.thread.id;
  await first.request("turn/start", {
    threadId: ephemeralThreadId,
    input: [{ type: "text", text: `Reply with exactly ${sentinel}. Do not call tools.` }],
  });
  const completed = await first.waitForNotification(
    "turn/completed",
    (params) => params?.threadId === ephemeralThreadId,
    { timeoutMs: 90_000 },
  );
  const observedEvents = [...new Set(first.notifications.map((entry) => entry.method))].sort();

  const handoff = syntheticHandoff();
  const routed = await startCodexTask({
    client: first,
    payload: handoff,
    cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  await first.waitForNotification(
    "turn/started",
    (params) => params?.threadId === routed.threadId && params?.turn?.id === routed.turnId,
  );
  await first.request("turn/interrupt", { threadId: routed.threadId, turnId: routed.turnId });
  const interrupted = await first.waitForNotification(
    "turn/completed",
    (params) => params?.threadId === routed.threadId && params?.turn?.id === routed.turnId,
  );

  let realtime;
  try {
    await first.request("thread/realtime/start", {
      threadId: ephemeralThreadId,
      outputModality: "audio",
    }, { timeoutMs: 20_000 });
    realtime = { available: true, error: null };
  } catch (error) {
    realtime = { available: false, error: error instanceof Error ? error.message : String(error) };
  }
  await first.stop();

  const second = new CodexAppServerClient({ cwd, timeoutMs: 30_000 });
  await second.start();
  const after = await listThreads(second);
  const afterIds = new Set((after.data ?? after.threads ?? []).map((thread) => thread.id));
  const recovered = afterIds.has(stableThreadId);
  await second.stop();
  if (!recovered) throw new Error(`Codex Thread ${stableThreadId} was not recovered after restart`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    account,
    stableThreadRecovery: { threadId: stableThreadId, recovered },
    ephemeralTurn: {
      threadId: ephemeralThreadId,
      status: completed.turn?.status ?? completed.status ?? null,
      observedEvents,
      sentinel,
    },
    exactTaskHandoff: {
      ticketId: routed.ticketId,
      threadId: routed.threadId,
      turnId: routed.turnId,
      status: interrupted.turn?.status ?? interrupted.status ?? null,
      payloadSha256: createHash("sha256").update(routed.payloadText).digest("hex"),
      browserDerived: false,
      syntheticNonSensitiveFixture: true,
    },
    realtime,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
