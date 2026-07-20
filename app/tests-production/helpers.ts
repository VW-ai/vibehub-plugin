import type { Page } from "@playwright/test";
import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  LiveShellSnapshotV1,
  TaskPanelSnapshot,
  WorkbenchBridgeResult,
} from "@vibehub/core/contracts";
import type { WorkbenchHostConfig } from "../src/workbench-host";
import {
  conflictOsmRedDiagnosed,
  panelForTask,
  liveShellBaseline,
  v8Baseline,
} from "../test/fixtures";

const HOST_ENDPOINT = "/__production-host";
const HOST: WorkbenchHostConfig = {
  endpoint: HOST_ENDPOINT,
  repo: { repoKey: "production-e2e", repoRoot: "/tmp/production-e2e", checkoutRoot: "/tmp/production-e2e/worktrees/live-shell", host: "codex" },
};

type MaybePromise<T> = T | Promise<T>;

export interface ProductionHostHandlers {
  getLiveShell?: () => MaybePromise<WorkbenchBridgeResult<LiveShellSnapshotV1>>;
  getSnapshot?: () => MaybePromise<WorkbenchBridgeResult<MapSnapshot>>;
  getTaskPanel?: (
    taskId: string,
  ) => MaybePromise<WorkbenchBridgeResult<TaskPanelSnapshot>>;
  getConflictDetail?: (
    conflictId: string,
  ) => MaybePromise<WorkbenchBridgeResult<ConflictCardSnapshot>>;
  applyIntervention?: () => MaybePromise<WorkbenchBridgeResult<AppliedIntervention>>;
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function installProductionHost(
  page: Page,
  handlers: ProductionHostHandlers = {},
): Promise<void> {
  await page.addInitScript((host: WorkbenchHostConfig) => {
    window.__VIBEHUB_WORKBENCH_HOST__ = host;
  }, HOST);

  await page.route(`**${HOST_ENDPOINT}`, async (route) => {
    const envelope = route.request().postDataJSON() as {
      method: string;
      request?: { taskId?: string; conflictId?: string };
    };
    let result: unknown;
    if (envelope.method === "getLiveShell") {
      if (handlers.getLiveShell) result = await handlers.getLiveShell();
      else if (handlers.getSnapshot) {
        const mapResult = await handlers.getSnapshot();
        result = mapResult.status === "ok"
          ? { status: "ok", data: { ...liveShellBaseline, workspace: { ...liveShellBaseline.workspace, data: { ...liveShellBaseline.workspace.data!, map: mapResult.data } } } }
          : mapResult;
      } else result = { status: "ok", data: liveShellBaseline };
    } else if (envelope.method === "getSnapshot") {
      result = await (handlers.getSnapshot?.() ?? { status: "ok", data: v8Baseline });
    } else if (envelope.method === "getTaskPanel") {
      const taskId = envelope.request?.taskId ?? "";
      const task = v8Baseline.tasks.find((candidate) => candidate.id === taskId);
      result = await (handlers.getTaskPanel?.(taskId) ??
        (task
          ? { status: "ok", data: panelForTask(task, v8Baseline) }
          : { status: "not_found", message: `Unknown task ${taskId}` }));
    } else if (envelope.method === "getConflictDetail") {
      const conflictId = envelope.request?.conflictId ?? "";
      result = await (handlers.getConflictDetail?.(conflictId) ?? {
        status: "ok",
        data: conflictOsmRedDiagnosed,
      });
    } else if (envelope.method === "applyIntervention") {
      result = await (handlers.applyIntervention?.() ?? {
        status: "ok",
        data: {
          requestId: "production-e2e-request",
          outcome: "applied",
          injectionIds: [],
          affectedTaskIds: [],
          acceptedAt: v8Baseline.capturedAt,
        },
      });
    } else {
      result = { status: "internal_error", message: `Unknown bridge method ${envelope.method}` };
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(result),
    });
  });
}

export async function openProduction(page: Page): Promise<void> {
  await page.goto("/");
  await page.locator('[data-source="workbench-bridge"]').waitFor();
  await page.locator(".window").evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
}

export const taskCard = (page: Page, taskId: string) =>
  page.locator(`[data-task="${taskId}"]`);

export const conflictPill = (page: Page) =>
  taskCard(page, "task-auto-retry-payments").locator(".pill");

export async function assertProductionEntryIsFixtureFree(page: Page): Promise<void> {
  const sources = await page.locator('script[type="module"][src]').evaluateAll((scripts) =>
    scripts.map((script) => (script as HTMLScriptElement).src),
  );
  for (const source of sources) {
    const body = await (await page.request.get(source)).text();
    if (/test\/fixtures|harness-main|fixture=v8-baseline/i.test(body)) {
      throw new Error(`production asset contains a fixture marker: ${source}`);
    }
  }
}
