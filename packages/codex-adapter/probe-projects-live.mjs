#!/usr/bin/env node

import { resolve } from "node:path";
import { CodexAppServerClient } from "./client.mjs";
import { CODEX_PROJECT_CAPABILITIES, CodexProjectsAdapter } from "./projects.mjs";

const cwd = resolve(process.cwd());
const marker = `VibeHub Project Probe ${Date.now()}`;
let client = null;
let projectId = null;
const threadIds = new Set();

async function cleanup() {
  if (!client) return;
  for (const threadId of threadIds) {
    try { await client.request("thread/delete", { threadId }); } catch {}
  }
  if (projectId) {
    try { await client.request("threadSection/delete", { sectionId: projectId }); } catch {}
  }
  await client.stop();
  client = null;
}

try {
  client = new CodexAppServerClient({ cwd, timeoutMs: 30_000 });
  await client.start();
  let adapter = new CodexProjectsAdapter({ client });
  const createdProject = await adapter.createProject(marker);
  projectId = createdProject.section.id;

  const started = await client.request("thread/start", {
    approvalPolicy: "never",
    cwd,
    ephemeral: false,
    sandbox: "read-only",
  });
  const originalId = started.thread.id;
  threadIds.add(originalId);
  await client.request("thread/name/set", { threadId: originalId, name: `${marker} Original` });
  const completed = client.waitForNotification("turn/completed", (params) => params?.threadId === originalId);
  await client.request("turn/start", {
    threadId: originalId,
    input: [{ type: "text", text: `Lifecycle marker: ${marker}. Reply with exactly PROJECT-PROBE-OK and do not use tools.` }],
  });
  await completed;
  await adapter.moveThread(originalId, projectId);

  const projectedBeforeFork = await adapter.listThreads({ projectId });
  const recentsBeforeFork = await adapter.listThreads({ projectId: null });
  if (!projectedBeforeFork.some((thread) => thread.id === originalId)) throw new Error("moved Thread missing from Project");
  if (recentsBeforeFork.some((thread) => thread.id === originalId)) throw new Error("projected Thread leaked into Recents");

  const forked = await adapter.forkThread(originalId);
  const forkId = forked.thread.id;
  threadIds.add(forkId);
  await client.request("thread/name/set", { threadId: forkId, name: `${marker} Fork` });
  if (forked.thread.forkedFromId !== originalId) throw new Error("fork lineage was not persisted");
  if (forked.thread.section?.id !== projectId) throw new Error("fork did not inherit source Project through adapter");
  if (!forked.placement.applied) throw new Error("fork Project placement reported fallback");

  await adapter.moveThread(originalId, null);
  const searched = await adapter.listThreads({ searchTerm: marker });
  if (!searched.some((thread) => thread.id === originalId && thread.project === null)) throw new Error("native title Search did not find unprojected Thread");

  await adapter.archiveThread(originalId);
  const archived = await adapter.listThreads({ archived: true });
  if (!archived.some((thread) => thread.id === originalId)) throw new Error("archived Thread was not listed");

  await client.stop();
  client = new CodexAppServerClient({ cwd, timeoutMs: 30_000 });
  await client.start();
  adapter = new CodexProjectsAdapter({ client });
  const recovered = await adapter.snapshot();
  const recoveredProject = recovered.projects.find((project) => project.id === projectId && project.name === marker);
  if (!recoveredProject?.threads.some((thread) => thread.id === forkId)) throw new Error("Project or fork membership did not recover after restart");
  if (recovered.recents.some((thread) => thread.id === originalId)) throw new Error("archived Thread appeared in Recents");

  const unarchived = await adapter.unarchiveThread(originalId);
  if (unarchived.thread.section !== null) throw new Error("unprojected archived Thread changed membership on restore");
  const recentsAfterRestore = await adapter.listThreads({ projectId: null });
  if (!recentsAfterRestore.some((thread) => thread.id === originalId)) throw new Error("restored unprojected Thread missing from Recents");

  await adapter.deleteProject(projectId);
  projectId = null;
  const recentsAfterDelete = await adapter.listThreads({ projectId: null });
  if (!recentsAfterDelete.some((thread) => thread.id === forkId)) throw new Error("deleting Project did not return member fork to Recents");

  const result = {
    ok: true,
    baseline: { codex: CODEX_PROJECT_CAPABILITIES.baseline.version, commit: CODEX_PROJECT_CAPABILITIES.baseline.commit },
    project: { created: true, stableId: createdProject.section.id, recoveredAfterRestart: true, deletedToRecents: true },
    original: { threadId: originalId, movedIn: true, movedOut: true, searchable: true, archived: true, unarchived: true },
    fork: { threadId: forkId, forkedFromId: forked.thread.forkedFromId, inheritedProject: true, recoveredAfterRestart: true },
    recents: { nativeSectionIdNull: true, excludesProjected: true, excludesArchived: true, includesMovedOut: true },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await cleanup();
}
