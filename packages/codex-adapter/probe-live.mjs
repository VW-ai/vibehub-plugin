#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexAppServerClient } from "./client.mjs";
import { startCodexTask } from "./handoff.mjs";
import { buildTicketHandoff } from "../../skills/vibehub-core/scripts/vh-ui.mjs";
import { RECORDING_MIME_TYPE } from "../../apps/codex-first-shell/composer-recording.mjs";

const cwd = process.cwd();
const sentinel = "VIBEHUB_CODEX_ADAPTER_OK";
const audioSentinel = "VIBEHUB_CODEX_AUDIO_OK";

// One real Opus-in-WebM sample (a 0.4 s sine tone, ffmpeg libopus): the exact
// container and codec the production Composer's MediaRecorder produces, so
// the one ephemeral audio Turn below proves the pinned runtime accepts the
// shell's own mimeType through the stable `audio` data-URL input. Embedded so
// the probe stays self-contained; nothing is read from or written to disk.
const AUDIO_SAMPLE_BASE64 =
  "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";

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
  const phase = (name) => process.stderr.write(`[probe-live] ${name}\n`);
  const first = new CodexAppServerClient({ cwd, timeoutMs: 90_000 });
  const second = new CodexAppServerClient({ cwd, timeoutMs: 30_000 });
  try {
    await runProbe({ first, second, phase });
  } finally {
    // A thrown probe must not leave a codex child holding the event loop
    // open with the failure unread: both clients stop on every path.
    await first.stop().catch(() => {});
    await second.stop().catch(() => {});
  }
}

async function runProbe({ first, second, phase }) {
  phase("starting codex app-server");
  await first.start();
  const account = await first.accountStatus();
  phase(`account read (authenticated: ${account.authenticated})`);
  const before = await listThreads(first);
  // A checkout nobody has used codex in lists no stable Thread for this cwd;
  // the restart recovery clause is then skipped by name instead of blocking
  // the ephemeral Turns (the host lifecycle guard proves recovery live).
  const stableThreadId = before.data?.[0]?.id ?? before.threads?.[0]?.id ?? null;
  phase(stableThreadId ? `stable Thread ${stableThreadId}` : "no stable Thread listed for this cwd; recovery clause will be skipped");

  phase("starting ephemeral read-only Thread");
  const started = await first.request("thread/start", {
    approvalPolicy: "never",
    cwd,
    ephemeral: true,
    sandbox: "read-only",
  });
  const ephemeralThreadId = started.thread.id;
  phase(`sentinel Turn on ephemeral Thread ${ephemeralThreadId}`);
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

  // The one ephemeral read-only audio Turn: the stable `audio` UserInput as a
  // data URL whose mime is exactly the shell's MediaRecorder mimeType, on the
  // same ephemeral Thread the sentinel Turn used. Ephemeral Threads leave no
  // listing (verified below against the restarted process), so there is
  // nothing to delete afterwards.
  const audioDataUrl = `data:${RECORDING_MIME_TYPE};base64,${AUDIO_SAMPLE_BASE64}`;
  phase(`ordinary audio Turn (${RECORDING_MIME_TYPE}, ${audioDataUrl.length} data-URL bytes)`);
  const audioStarted = await first.request("turn/start", {
    threadId: ephemeralThreadId,
    input: [
      { type: "text", text: `This message carries one short recorded audio attachment. Reply with exactly ${audioSentinel}. Do not call tools.` },
      { type: "audio", url: audioDataUrl },
    ],
  });
  const audioTurnId = audioStarted.turn?.id;
  if (!audioTurnId) throw new Error("turn/start for the audio Turn returned no turn id");
  const audioCompleted = await first.waitForNotification(
    "turn/completed",
    (params) => params?.threadId === ephemeralThreadId && params?.turn?.id === audioTurnId,
    { timeoutMs: 90_000 },
  );

  phase(`audio Turn ${audioTurnId} completed (${audioCompleted.turn?.status ?? audioCompleted.status ?? "unknown"})`);
  const handoff = syntheticHandoff();
  phase("exact Task handoff Turn (interrupted at once)");
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

  phase("restarting for the recovery and no-listing reads");
  await second.start();
  const after = await listThreads(second);
  const afterIds = new Set((after.data ?? after.threads ?? []).map((thread) => thread.id));
  const recovered = stableThreadId ? afterIds.has(stableThreadId) : null;
  // The ephemeral Thread that carried the sentinel and audio Turns must not
  // be listed by the restarted process: ephemeral Threads leave no listing,
  // so the probe deletes nothing because nothing durable was created.
  const ephemeralListed = afterIds.has(ephemeralThreadId);
  await second.stop();
  if (stableThreadId && !recovered) throw new Error(`Codex Thread ${stableThreadId} was not recovered after restart`);
  if (ephemeralListed) throw new Error(`ephemeral Thread ${ephemeralThreadId} appeared in the restarted process's listing; the leave-no-listing claim no longer holds`);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    account,
    stableThreadRecovery: stableThreadId
      ? { threadId: stableThreadId, recovered }
      : { skipped: true, reason: "thread/list returned no stable Thread for this cwd; restart recovery stays proven by the host lifecycle guard" },
    ephemeralTurn: {
      threadId: ephemeralThreadId,
      status: completed.turn?.status ?? completed.status ?? null,
      observedEvents,
      sentinel,
    },
    ordinaryAudioTurn: {
      threadId: ephemeralThreadId,
      turnId: audioTurnId,
      mimeType: RECORDING_MIME_TYPE,
      dataUrlBytes: audioDataUrl.length,
      status: audioCompleted.turn?.status ?? audioCompleted.status ?? null,
      ephemeralLeavesNoListing: !ephemeralListed,
      sentinel: audioSentinel,
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
