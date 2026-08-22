#!/usr/bin/env node

import { resolve } from "node:path";
import { CodexAppServerClient } from "./client.mjs";
import { CodexProjectsAdapter } from "./projects.mjs";

export const BROWSER_E2E_PROJECT_NAME = "__VIBEHUB_PROJECT_BROWSER_E2E__";
export const BROWSER_E2E_THREAD_NAME = "__VIBEHUB_PROJECT_BROWSER_E2E_THREAD__";

const operation = process.argv[2];
if (!new Set(["setup", "cleanup"]).has(operation)) {
  process.stderr.write("usage: node prepare-project-browser-e2e.mjs <setup|cleanup>\n");
  process.exitCode = 2;
} else {
  const cwd = resolve(process.cwd());
  const client = new CodexAppServerClient({ cwd, timeoutMs: 30_000 });
  try {
    await client.start();
    const projects = new CodexProjectsAdapter({ client });
    const cleanup = async () => {
      const snapshot = await projects.snapshot();
      const threadIds = snapshot.threads.filter((thread) => thread.title === BROWSER_E2E_THREAD_NAME).map((thread) => thread.id);
      const projectIds = snapshot.projects.filter((section) => section.name === BROWSER_E2E_PROJECT_NAME).map((section) => section.id);
      for (const threadId of threadIds) await client.request("thread/delete", { threadId });
      for (const sectionId of projectIds) await client.request("threadSection/delete", { sectionId });
      return { threadIds, projectIds };
    };

    const removed = await cleanup();
    if (operation === "cleanup") {
      process.stdout.write(`${JSON.stringify({ ok: true, operation, removed }, null, 2)}\n`);
    } else {
      const createdProject = await projects.createProject(BROWSER_E2E_PROJECT_NAME);
      const started = await client.request("thread/start", {
        approvalPolicy: "never",
        cwd,
        ephemeral: false,
        sandbox: "read-only",
      });
      await client.request("thread/name/set", { threadId: started.thread.id, name: BROWSER_E2E_THREAD_NAME });
      const completed = client.waitForNotification("turn/completed", (params) => params?.threadId === started.thread.id);
      await client.request("turn/start", {
        threadId: started.thread.id,
        input: [{ type: "text", text: "Reply with exactly PROJECT-BROWSER-E2E-READY and do not use tools." }],
      });
      await completed;
      process.stdout.write(`${JSON.stringify({
        ok: true,
        operation,
        cleanedBeforeSetup: removed,
        project: createdProject.section,
        thread: { id: started.thread.id, name: BROWSER_E2E_THREAD_NAME, section: null, materialized: true },
      }, null, 2)}\n`);
    }
  } finally {
    await client.stop();
  }
}
