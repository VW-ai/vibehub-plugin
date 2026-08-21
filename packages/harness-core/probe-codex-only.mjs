#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCodexHarnessAdapter } from "../codex-adapter/harness.mjs";
import { createFileAssociationStore } from "./association-store.mjs";
import { createFixtureClient } from "./fixtures.mjs";
import { probePackageIsolation } from "./probe-package-isolation.mjs";
import { createSharedHarnessShell } from "./shell.mjs";

export async function probeCodexOnlyRoute() {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-codex-only-"));
  const associationPath = join(temp, "state", "task-conversations.json");
  let firstStore;
  let secondStore;
  try {
    firstStore = await createFileAssociationStore(associationPath);
    const firstClient = createFixtureClient({ prefix: "codex-only-first" });
    const first = createSharedHarnessShell({
      adapter: createCodexHarnessAdapter({ client: firstClient }),
      associations: firstStore,
    });
    const firstBoot = first.boot();
    const chat = await first.newChat({ cwd: temp });
    await first.sendChat({
      conversationId: chat.conversationId,
      content: [{ type: "text", text: "ordinary Codex Chat" }],
    });
    const payload = {
      schemaVersion: 1,
      kind: "vibehub_ticket_handoff",
      ticketId: "ticket-clean-codex-only-probe",
      acceptance: [{ acceptance_id: "exact", criterion: "Exact host-owned handoff" }],
    };
    const task = await first.startTask({
      cwd: temp,
      payload,
      origin: { threadId: chat.conversationId, turnRange: [1, 1] },
    });
    const payloadCall = firstClient.calls.find((call) =>
      call.method === "turn/start" && call.params.threadId === task.conversationId);
    const exactHandoff = JSON.stringify(payloadCall?.params?.input?.[0]?.text ? JSON.parse(payloadCall.params.input[0].text) : null) === JSON.stringify(payload);
    await first.close();

    secondStore = await createFileAssociationStore(associationPath);
    const secondClient = createFixtureClient({ prefix: "codex-only-second" });
    const restarted = createSharedHarnessShell({
      adapter: createCodexHarnessAdapter({ client: secondClient }),
      associations: secondStore,
    });
    const restartBoot = restarted.boot();
    const recovered = await restarted.recoverTask(payload.ticketId);
    await restarted.close();
    const isolation = await probePackageIsolation();
    await secondStore.remove();
    const removed = !existsSync(associationPath);
    return {
      ok: exactHandoff
        && recovered?.conversationId === task.conversationId
        && recovered?.harnessId === "codex"
        && isolation.ok
        && removed,
      carrier: "codex",
      shell: {
        firstBoot: firstBoot.carrierId,
        restartBoot: restartBoot.carrierId,
      },
      ordinaryChat: {
        conversationId: chat.conversationId,
        requestMethods: firstClient.calls.slice(0, 2).map((call) => call.method),
      },
      taskHandoff: {
        ticketId: payload.ticketId,
        conversationId: task.conversationId,
        exactHandoff,
      },
      restart: { recovered },
      packageIsolation: isolation,
      removal: { removed },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = await probeCodexOnlyRoute();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
