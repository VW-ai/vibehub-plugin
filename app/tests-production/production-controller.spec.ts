import { expect, test, type Locator, type Page } from "@playwright/test";
import { conflictOsmRedDiagnosed, panelForTask, v8Baseline } from "../test/fixtures";
import {
  assertProductionEntryIsFixtureFree,
  conflictPill,
  installProductionHost,
  openConflictDetail,
  openProduction,
  taskCard,
  wait,
} from "./helpers";

async function expectAboveScrim(page: Page, surface: Locator) {
  const result = await surface.evaluate((element) => {
    const scrim = document.querySelector<HTMLElement>(".scrim");
    const layer = element.closest<HTMLElement>(".center") ?? element;
    return {
      surfacePointerEvents: getComputedStyle(element).pointerEvents,
      layerZ: Number(getComputedStyle(layer).zIndex),
      scrimZ: scrim ? Number(getComputedStyle(scrim).zIndex) : -1,
    };
  });
  expect(result.surfacePointerEvents).not.toBe("none");
  expect(result.layerZ).toBeGreaterThan(result.scrimZ);
}

test("production conflict detail stays in the corner canvas layer without a scrim", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  await assertProductionEntryIsFixtureFree(page);
  await conflictPill(page).click();
  const signal = page.getByRole("region", { name: "Conflict signal" });
  await expect(signal).toBeVisible();
  await expect(page.locator(".scrim")).toHaveCount(0);
  const modal = await openConflictDetail(page);
  await expect(modal).toBeVisible();
  await wait(350);
  const layer = (await page.locator(".corner-signal-layer").boundingBox())!;
  const rail = (await page.locator(".rail").boundingBox())!;
  const box = (await modal.boundingBox())!;
  expect(layer.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  expect(box.x).toBeGreaterThanOrEqual(layer.x);
  expect(box.x + box.width).toBeLessThanOrEqual(layer.x + layer.width);
  expect(box.y + box.height).toBeLessThanOrEqual(layer.y + layer.height);
});

test("production detail error remains operable above scrim", async ({ page }) => {
  await installProductionHost(page, {
    getConflictDetail: () => ({ status: "internal_error", message: "Evidence backend failed" }),
  });
  await openProduction(page);
  await conflictPill(page).click();
  const error = page.locator(".center .bootstrap-state");
  await expect(error).toContainText("Evidence backend failed");
  await expectAboveScrim(page, error);
  await error.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("latest task selection wins when detail responses resolve out of order", async ({ page }) => {
  await installProductionHost(page, {
    getTaskPanel: async (taskId) => {
      await wait(taskId === "task-refactor-auth" ? 300 : 20);
      const task = v8Baseline.tasks.find((candidate) => candidate.id === taskId)!;
      return { status: "ok", data: panelForTask(task, v8Baseline) };
    },
  });
  await openProduction(page);
  await taskCard(page, "task-refactor-auth").click();
  await taskCard(page, "task-migrate-sqlite").click();
  await expect(page.getByRole("dialog", { name: /Migrate SQLite/ })).toBeVisible();
  await wait(350);
  await expect(page.getByRole("dialog", { name: /Migrate SQLite/ })).toBeVisible();
  await expect(page.getByRole("dialog", { name: /Refactor auth/ })).toHaveCount(0);
});

test("closing a loading detail prevents late modal resurrection", async ({ page }) => {
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  await installProductionHost(page, {
    getTaskPanel: async (taskId) => {
      await responseGate;
      const task = v8Baseline.tasks.find((candidate) => candidate.id === taskId)!;
      return { status: "ok", data: panelForTask(task, v8Baseline) };
    },
  });
  await openProduction(page);
  await taskCard(page, "task-refactor-auth").click();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  releaseResponse();
  await wait(100);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("task response cannot overwrite a later conflict selection", async ({ page }) => {
  await installProductionHost(page, {
    getTaskPanel: async (taskId) => {
      await wait(300);
      const task = v8Baseline.tasks.find((candidate) => candidate.id === taskId)!;
      return { status: "ok", data: panelForTask(task, v8Baseline) };
    },
    getConflictDetail: async () => {
      await wait(20);
      return { status: "ok", data: conflictOsmRedDiagnosed };
    },
  });
  await openProduction(page);
  await taskCard(page, "task-refactor-auth").click();
  await conflictPill(page).click();
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await wait(350);
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await expect(page.locator(".panel")).toHaveCount(0);
});

test("production panel closes on Escape and restores exact task-card focus", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const opener = taskCard(page, "task-refactor-auth");
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".panel")).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("production conflict Escape restores exact pill focus", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const opener = conflictPill(page);
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Conflict signal" })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("task opened from conflict restores the durable conflict pill", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const opener = conflictPill(page);
  await opener.focus();
  await page.keyboard.press("Enter");
  const conflict = await openConflictDetail(page);
  await expect(conflict).toBeVisible();
  await conflict.locator(".side").first().click();
  const panel = page.locator(".panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close panel" }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("production conflict child Escape takes priority before conflict close", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const opener = conflictPill(page);
  await opener.focus();
  await page.keyboard.press("Enter");
  const conflict = await openConflictDetail(page);
  const pauseTrigger = conflict.getByRole("button", { name: /Pause one side/ });
  await pauseTrigger.click();
  await expect(conflict.getByRole("menu")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(conflict.getByRole("menu")).toHaveCount(0);
  await expect(conflict).toBeVisible();
  await expect(pauseTrigger).toBeFocused();

  const ignoreTrigger = conflict.getByRole("button", { name: "Ignore this pair" });
  await ignoreTrigger.click();
  await expect(conflict.getByRole("group", { name: "Confirm ignore" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(conflict.getByRole("group", { name: "Confirm ignore" })).toHaveCount(0);
  await expect(ignoreTrigger).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(conflict).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await expect(opener).not.toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Conflict signal" })).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("production same task or conflict opener toggles the open surface closed", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const task = taskCard(page, "task-refactor-auth");
  await task.click();
  await expect(page.locator(".panel")).toBeVisible();
  await task.click();
  await expect(page.locator(".panel")).toHaveCount(0);
  await expect(task).toBeFocused();

  const pill = conflictPill(page);
  await pill.click();
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await pill.click();
  await expect(page.getByRole("region", { name: "Conflict signal" })).toHaveCount(0);
  await expect(pill).toBeFocused();
});

test("production rail resizes by pointer and keyboard, clamps 240 through 480, persists and resets", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const rail = page.locator(".rail");
  const divider = page.locator(".divider");
  const width = async () => Math.round((await rail.boundingBox())!.width);
  const drag = async (dx: number) => {
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  };

  expect(await width()).toBe(300);
  await drag(-500);
  expect(await width()).toBe(240);
  await divider.focus();
  await page.keyboard.press("ArrowRight");
  expect(await width()).toBe(256);
  await drag(600);
  expect(await width()).toBe(480);
  await page.reload();
  await page.locator('[data-source="workbench-bridge"]').waitFor();
  await page.locator(".window").evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  expect(await width()).toBe(480);
  await divider.dblclick();
  expect(await width()).toBe(300);
  await expect(divider).toHaveAttribute("aria-valuemin", "240");
  await expect(divider).toHaveAttribute("aria-valuemax", "480");
  await expect(divider).toHaveAttribute("aria-valuenow", "300");
});
