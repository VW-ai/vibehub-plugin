import { expect, test } from "@playwright/test";
import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  TaskPanelSnapshot,
} from "@vibehub/core/contracts";
import { conflictOsmRedDiagnosed, panelForTask, v8Baseline } from "../test/fixtures";
import {
  conflictPill,
  installProductionHost,
  openProduction,
  taskCard,
  wait,
} from "./helpers";

const TASK_ID = "task-refactor-auth";
const ACCEPTED_AT = "2026-07-13T18:24:00.000Z";

function mapWithTaskTitle(title: string): MapSnapshot {
  return {
    ...v8Baseline,
    tasks: v8Baseline.tasks.map((task) =>
      task.id === TASK_ID ? { ...task, title } : task,
    ),
  };
}

function panelWithTitle(title: string): TaskPanelSnapshot {
  const map = mapWithTaskTitle(title);
  const task = map.tasks.find((candidate) => candidate.id === TASK_ID)!;
  const panel = panelForTask(task, map);
  return { ...panel, task: { ...panel.task, title } };
}

function receipt(
  outcome: AppliedIntervention["outcome"],
  message: string,
): AppliedIntervention {
  return {
    requestId: `request-${outcome}`,
    outcome,
    injectionIds: outcome === "applied" ? [41] : [],
    affectedTaskIds: [TASK_ID],
    acceptedAt: ACCEPTED_AT,
    message,
  };
}

test("successful task intervention renders queued receipt and refreshes task detail", async ({ page }) => {
  let snapshotReads = 0;
  let detailReads = 0;
  await installProductionHost(page, {
    getSnapshot: () => {
      snapshotReads += 1;
      return {
        status: "ok",
        data: snapshotReads === 1
          ? v8Baseline
          : mapWithTaskTitle("Refactor auth — refreshed"),
      };
    },
    getTaskPanel: () => {
      detailReads += 1;
      return {
        status: "ok",
        data: panelWithTitle(
          detailReads === 1 ? "Refactor auth" : "Refactor auth — refreshed",
        ),
      };
    },
    applyIntervention: () => ({
      status: "ok",
      data: receipt("applied", "Queued for the next hook boundary."),
    }),
  });

  await openProduction(page);
  await taskCard(page, TASK_ID).click();
  const panel = page.locator(".panel");
  await panel.locator("textarea").fill("Please preserve the retry evidence.");
  await panel.getByRole("button", { name: "Send" }).click();

  const renderedReceipt = panel.getByRole("status");
  await expect(renderedReceipt).toContainText("applied");
  await expect(renderedReceipt).toContainText("Queued for the next hook boundary.");
  await expect(renderedReceipt).toContainText(ACCEPTED_AT);
  await expect(panel).toContainText("Refactor auth — refreshed");
  await expect(taskCard(page, TASK_ID)).toContainText("Refactor auth — refreshed");
  await expect(panel.locator("textarea")).toHaveValue("");
  await expect.poll(() => snapshotReads).toBe(2);
  await expect.poll(() => detailReads).toBe(2);
});

test("successful conflict intervention refreshes map and conflict detail", async ({ page }) => {
  let snapshotReads = 0;
  let detailReads = 0;
  const refreshedConflict: ConflictCardSnapshot = {
    ...conflictOsmRedDiagnosed,
    diagnosis: conflictOsmRedDiagnosed.diagnosis
      ? {
          ...conflictOsmRedDiagnosed.diagnosis,
          verdict: "Refreshed after adjudication.",
        }
      : null,
  };
  await installProductionHost(page, {
    getSnapshot: () => {
      snapshotReads += 1;
      return {
        status: "ok",
        data: snapshotReads === 1
          ? v8Baseline
          : mapWithTaskTitle("Refactor auth — map refreshed"),
      };
    },
    getConflictDetail: () => {
      detailReads += 1;
      return {
        status: "ok",
        data: detailReads === 1 ? conflictOsmRedDiagnosed : refreshedConflict,
      };
    },
    applyIntervention: () => ({
      status: "ok",
      // inject_both persists exactly two queue rows — strong evidence.
      data: { ...receipt("applied", "Both queue rows were accepted atomically."), injectionIds: [41, 42] },
    }),
  });

  await openProduction(page);
  await conflictPill(page).click();
  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  await conflict.locator("textarea").fill("Coordinate ownership before editing.");
  await conflict.getByRole("button", { name: "Inject to both" }).click();

  const renderedReceipt = conflict.getByRole("status");
  await expect(renderedReceipt).toContainText("applied");
  await expect(renderedReceipt).toContainText("Both queue rows were accepted atomically.");
  await expect(renderedReceipt).toContainText(ACCEPTED_AT);
  await expect(conflict).toContainText("Refreshed after adjudication.");
  await expect(taskCard(page, TASK_ID)).toContainText("Refactor auth — map refreshed");
  await expect.poll(() => snapshotReads).toBe(2);
  await expect.poll(() => detailReads).toBe(2);
});

test("stale no-op and unsupported receipts remain explicit", async ({ page }) => {
  const outcomes: Array<[AppliedIntervention["outcome"], string]> = [
    ["stale", "The target task changed before this request was accepted."],
    ["no_op", "The requested pause already matches current state."],
    ["unsupported", "This adapter cannot deliver interventions."],
  ];
  let applyCount = 0;
  let snapshotReads = 0;
  let detailReads = 0;
  await installProductionHost(page, {
    getSnapshot: () => {
      snapshotReads += 1;
      return { status: "ok", data: v8Baseline };
    },
    getTaskPanel: () => {
      detailReads += 1;
      return { status: "ok", data: panelWithTitle("Refactor auth") };
    },
    applyIntervention: () => {
      const [outcome, message] = outcomes[applyCount++]!;
      return { status: "ok", data: receipt(outcome, message) };
    },
  });

  await openProduction(page);
  await taskCard(page, TASK_ID).click();
  const panel = page.locator(".panel");
  const input = panel.locator("textarea");
  for (const [outcome, message] of outcomes) {
    const draft = `corrective draft for ${outcome}`;
    await input.fill(draft);
    await panel.getByRole("button", { name: "Send" }).click();
    const renderedReceipt = panel.getByRole("status");
    await expect(renderedReceipt).toContainText(outcome);
    await expect(renderedReceipt).toContainText(message);
    await expect(renderedReceipt).toContainText(ACCEPTED_AT);
    await expect(renderedReceipt).not.toContainText(/queued|delivered/i);
    await expect(input).toHaveValue(draft);
  }

  expect(snapshotReads).toBe(1);
  expect(detailReads).toBe(1);
});

for (const outcome of ["applied", "already_applied"] as const) {
  test(`evidence-unavailable ignore keeps its surface open with the ${outcome} receipt`, async ({ page }) => {
    let conflictReads = 0;
    await installProductionHost(page, {
      getConflictDetail: () => {
        conflictReads += 1;
        return {
          status: "evidence_unavailable",
          message: "The rich symbol evidence is not available for this pair.",
        };
      },
      applyIntervention: () => ({
        status: "ok",
        data: receipt(outcome, `${outcome} ignore receipt from SQLite.`),
      }),
    });

    await openProduction(page);
    await conflictPill(page).click();
    const fallback = page.getByRole("dialog");
    await expect(fallback).toContainText("Rich evidence unavailable");
    await fallback.getByRole("button", { name: "Ignore this pair" }).click();

    const renderedReceipt = fallback.getByRole("status");
    await expect(renderedReceipt).toContainText(outcome);
    await expect(renderedReceipt).toContainText(`${outcome} ignore receipt from SQLite.`);
    await expect(renderedReceipt).toContainText(ACCEPTED_AT);
    await expect(fallback).toBeVisible();
    await expect(fallback.getByRole("button", { name: "Close" })).toBeVisible();
    await expect.poll(() => conflictReads).toBe(2);
  });
}

test("a delayed fallback ignore cannot resurrect over a newer task panel", async ({ page }) => {
  let releaseIgnore!: () => void;
  const ignoreGate = new Promise<void>((resolve) => {
    releaseIgnore = resolve;
  });
  let applyStarted = false;
  await installProductionHost(page, {
    getConflictDetail: () => ({
      status: "evidence_unavailable",
      message: "The rich symbol evidence is not available for this pair.",
    }),
    applyIntervention: async () => {
      applyStarted = true;
      await ignoreGate;
      return {
        status: "ok",
        data: receipt("applied", "This stale ignore receipt must stay hidden."),
      };
    },
  });

  await openProduction(page);
  await conflictPill(page).click();
  const fallback = page.getByRole("dialog");
  await expect(fallback).toContainText("Rich evidence unavailable");
  await fallback.getByRole("button", { name: "Ignore this pair" }).click();
  await expect.poll(() => applyStarted).toBe(true);

  await fallback.getByRole("button", { name: "Close" }).click();
  await taskCard(page, TASK_ID).click();
  const newerPanel = page.getByRole("dialog", { name: /Refactor auth/ });
  await expect(newerPanel).toBeVisible();

  releaseIgnore();
  await wait(100);

  await expect(newerPanel).toBeVisible();
  await expect(page.getByText("Rich evidence unavailable")).toHaveCount(0);
  await expect(page.getByText("This stale ignore receipt must stay hidden.")).toHaveCount(0);
  await expect(taskCard(page, TASK_ID)).toContainText("Refactor auth");
});

test("an accepted refresh cannot overwrite a later task target or the map", async ({ page }) => {
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let snapshotReads = 0;
  let firstTaskReads = 0;
  await installProductionHost(page, {
    getSnapshot: async () => {
      snapshotReads += 1;
      if (snapshotReads > 1) {
        await refreshGate;
        return { status: "ok", data: mapWithTaskTitle("STALE ACCEPTED REFRESH") };
      }
      return { status: "ok", data: v8Baseline };
    },
    getTaskPanel: async (taskId) => {
      if (taskId === TASK_ID) {
        firstTaskReads += 1;
        if (firstTaskReads > 1) {
          await refreshGate;
          return { status: "ok", data: panelWithTitle("STALE ACCEPTED REFRESH") };
        }
      }
      const task = v8Baseline.tasks.find((candidate) => candidate.id === taskId)!;
      return { status: "ok", data: panelForTask(task, v8Baseline) };
    },
    applyIntervention: () => ({
      status: "ok",
      data: receipt("applied", "Accepted before the refresh was delayed."),
    }),
  });

  await openProduction(page);
  await taskCard(page, TASK_ID).click();
  const firstPanel = page.locator(".panel");
  await firstPanel.locator("textarea").fill("Start the delayed accepted refresh.");
  await firstPanel.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => snapshotReads).toBe(2);
  await expect.poll(() => firstTaskReads).toBe(2);

  await taskCard(page, "task-migrate-sqlite").click();
  await expect(page.getByRole("dialog", { name: /Migrate SQLite/ })).toBeVisible();
  releaseRefresh();
  await wait(100);

  await expect(page.getByRole("dialog", { name: /Migrate SQLite/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /STALE ACCEPTED REFRESH/ })).toHaveCount(0);
  await expect(taskCard(page, TASK_ID)).not.toContainText("STALE ACCEPTED REFRESH");
});

test("task intervention clears an old receipt when the next bridge request fails", async ({ page }) => {
  let applyCount = 0;
  await installProductionHost(page, {
    applyIntervention: () => {
      applyCount += 1;
      return applyCount === 1
        ? { status: "ok", data: receipt("already_applied", "The first request was already accepted.") }
        : { status: "internal_error", message: "The second task request failed at the bridge." };
    },
  });

  await openProduction(page);
  await taskCard(page, TASK_ID).click();
  const panel = page.locator(".panel");
  const input = panel.locator("textarea");
  await input.fill("First request");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("status")).toContainText("already_applied");

  await input.fill("Keep this second draft");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("alert")).toContainText("The second task request failed at the bridge.");
  await expect(panel.getByRole("status")).toHaveCount(0);
  await expect(input).toHaveValue("Keep this second draft");
});

test("conflict intervention clears an old receipt when the next bridge request fails", async ({ page }) => {
  let applyCount = 0;
  await installProductionHost(page, {
    applyIntervention: () => {
      applyCount += 1;
      return applyCount === 1
        ? { status: "ok", data: receipt("already_applied", "The first conflict request was already accepted.") }
        : { status: "internal_error", message: "The second conflict request failed at the bridge." };
    },
  });

  await openProduction(page);
  await conflictPill(page).click();
  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  const input = conflict.locator("textarea");
  await input.fill("First conflict request");
  await conflict.getByRole("button", { name: "Inject to both" }).click();
  await expect(conflict.getByRole("status")).toContainText("already_applied");

  await input.fill("Keep this second conflict draft");
  await conflict.getByRole("button", { name: "Inject to both" }).click();
  await expect(conflict.getByRole("alert")).toContainText("The second conflict request failed at the bridge.");
  await expect(conflict.getByRole("status")).toHaveCount(0);
  await expect(input).toHaveValue("Keep this second conflict draft");
});

test("receipt projection leads with queued only on strong evidence; weak evidence renders the raw outcome", async ({ page }) => {
  const responses: AppliedIntervention[] = [
    receipt("applied", "Queued for the next hook boundary."),
    { ...receipt("applied", "Bridge accepted without persisted ids."), injectionIds: [] },
  ];
  let sends = 0;
  await installProductionHost(page, {
    applyIntervention: () => ({
      status: "ok",
      data: responses[Math.min(sends++, responses.length - 1)]!,
    }),
  });

  await openProduction(page);
  await taskCard(page, TASK_ID).click();
  const panel = page.locator(".panel");
  const input = panel.locator("textarea");

  await input.fill("First — strong evidence");
  await panel.getByRole("button", { name: "Send" }).click();
  const strong = panel.getByRole("status");
  await expect(strong).toContainText("queued");
  await expect(strong).toContainText("applied");
  await expect(strong).toContainText("Queued for the next hook boundary.");

  await input.fill("Second — weak evidence");
  await panel.getByRole("button", { name: "Send" }).click();
  const weak = panel.getByRole("status");
  await expect(weak).toContainText("Bridge accepted without persisted ids.");
  await expect(weak).toContainText("applied");
  await expect(weak).not.toContainText(/queued/i);
  await expect(input).toHaveValue("Second — weak evidence");
});

test("conflict card never celebrates QUEUED on weak evidence — the receipt line carries the raw fact", async ({ page }) => {
  await installProductionHost(page, {
    applyIntervention: () => ({
      status: "ok",
      // A success outcome with no persisted queue ids is weak evidence.
      data: { ...receipt("applied", "Accepted without persisted queue rows."), injectionIds: [] },
    }),
  });

  await openProduction(page);
  await conflictPill(page).click();
  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  await conflict.locator("textarea").fill("Coordinate ownership before editing.");
  await conflict.getByRole("button", { name: "Inject to both" }).click();

  const status = conflict.getByRole("status");
  await expect(status).toContainText("applied");
  await expect(status).toContainText("Accepted without persisted queue rows.");
  await expect(status).not.toContainText(/queued/i);
  await expect(conflict).not.toContainText("QUEUED");
  await expect(conflict).not.toContainText("SQLite accepted both queue rows");
  await expect(conflict.locator("textarea")).toHaveValue("Coordinate ownership before editing.");
});
