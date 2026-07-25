import { expect, test } from "@playwright/test";
import { conflictPill, installProductionHost, openProduction } from "./helpers";

async function openSignal(page: import("@playwright/test").Page) {
  const opener = conflictPill(page);
  await opener.focus();
  await opener.press("Enter");
  const signal = page.getByRole("region", { name: "Conflict signal" });
  await expect(signal).toBeVisible();
  return { opener, signal };
}

test("real conflict detail opens honest compact signal, expands, collapses, and dismisses distinctly", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const { opener, signal } = await openSignal(page);

  await expect(signal).toContainText("Work may be intersecting");
  await expect(signal).not.toContainText("Scope may be changing");
  await expect(page.locator(".scrim")).toHaveCount(0);

  await signal.getByRole("button", { name: "Expand conflict details" }).click();
  const dialog = page.getByRole("dialog", { name: /Conflict:/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Collapse conflict details" }).click();
  await expect(signal).toBeVisible();
  await expect(dialog).toHaveCount(0);

  await signal.getByRole("button", { name: "Dismiss conflict signal" }).click();
  await expect(signal).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("structured result enters receipt while bridge errors remain expanded", async ({ page }) => {
  let calls = 0;
  await installProductionHost(page, {
    applyIntervention: () => {
      calls += 1;
      return calls === 1
        ? { status: "internal_error", message: "The host rejected this request." }
        : {
            status: "ok",
            data: {
              requestId: "corner-receipt",
              outcome: "applied",
              injectionIds: [41, 42],
              affectedTaskIds: ["task-auto-retry-payments", "task-cancel-orders"],
              acceptedAt: "2026-07-24T12:00:00.000Z",
              message: "Both queue rows were accepted.",
            },
          };
    },
  });
  await openProduction(page);
  const { signal } = await openSignal(page);
  await signal.getByRole("button", { name: "Expand conflict details" }).click();
  const dialog = page.getByRole("dialog", { name: /Conflict:/ });
  await dialog.locator("textarea").fill("Coordinate ownership.");
  await dialog.getByRole("button", { name: "Inject to both" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The host rejected this request.");
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Inject to both" }).click();
  const receipt = page.getByRole("region", { name: "Conflict intervention receipt" });
  await expect(receipt).toContainText("queued");
  await expect(receipt).toContainText("applied");
  await expect(receipt).toContainText("Both queue rows were accepted.");
  await expect(dialog).toHaveCount(0);
});

test("a delayed intervention cannot resurrect receipt after the user collapses", async ({ page }) => {
  let release!: () => void;
  let started = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await installProductionHost(page, {
    applyIntervention: async () => {
      started = true;
      await gate;
      return {
        status: "ok",
        data: {
          requestId: "delayed-corner-receipt",
          outcome: "applied",
          injectionIds: [51, 52],
          affectedTaskIds: ["task-auto-retry-payments", "task-cancel-orders"],
          acceptedAt: "2026-07-24T12:00:00.000Z",
        },
      };
    },
  });
  await openProduction(page);
  const { signal } = await openSignal(page);
  await signal.getByRole("button", { name: "Expand conflict details" }).click();
  const dialog = page.getByRole("dialog", { name: /Conflict:/ });
  await dialog.locator("textarea").fill("Coordinate after review.");
  await dialog.getByRole("button", { name: "Inject to both" }).click();
  await expect.poll(() => started).toBe(true);
  await dialog.getByRole("button", { name: "Collapse conflict details" }).click();
  release();
  await expect(page.getByRole("region", { name: "Conflict signal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Conflict intervention receipt" })).toHaveCount(0);
});

test("drag position survives dismiss, reopen, and reload while malformed storage reclamps", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("corner-position-seeded")) {
      sessionStorage.setItem("vibehub-workbench.corner-conflict-signal-position", '{"x":9999,"y":-40}');
      sessionStorage.setItem("corner-position-seeded", "true");
    }
  });
  await installProductionHost(page);
  await openProduction(page);
  let { signal } = await openSignal(page);
  const handle = signal.getByRole("button", { name: "Move conflict signal" });
  await handle.press("ArrowLeft");
  const moved = (await signal.boundingBox())!;
  const movedLayer = (await page.locator(".corner-signal-layer").boundingBox())!;
  await signal.getByRole("button", { name: "Dismiss conflict signal" }).click();

  ({ signal } = await openSignal(page));
  const reopened = (await signal.boundingBox())!;
  expect(Math.abs(reopened.x - moved.x)).toBeLessThan(1);
  expect(Math.abs(reopened.y - moved.y)).toBeLessThan(1);

  await page.reload();
  await page.locator('[data-source="workbench-bridge"]').waitFor();
  await page.locator(".window").evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  ({ signal } = await openSignal(page));
  const reloaded = (await signal.boundingBox())!;
  const reloadedLayer = (await page.locator(".corner-signal-layer").boundingBox())!;
  expect(Math.abs((reloaded.x - reloadedLayer.x) - (moved.x - movedLayer.x))).toBeLessThan(1);
  expect(Math.abs((reloaded.y - reloadedLayer.y) - (moved.y - movedLayer.y))).toBeLessThan(1);
});

test("expanded actions, pause menu, and receipt stay inside a 760px canvas with the maximum rail", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("vibehub-workbench.railWidth", "480"));
  await installProductionHost(page, {
    applyIntervention: () => ({
      status: "ok",
      data: {
        requestId: "narrow-corner-receipt",
        outcome: "applied",
        injectionIds: [71],
        affectedTaskIds: ["task-auto-retry-payments"],
        acceptedAt: "2026-07-24T12:00:00.000Z",
      },
    }),
  });
  await openProduction(page);
  const { signal } = await openSignal(page);
  await signal.getByRole("button", { name: "Expand conflict details" }).click();
  const layer = (await page.locator(".corner-signal-layer").boundingBox())!;
  const insideLayer = async (locator: import("@playwright/test").Locator) => {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(layer.x);
    expect(box.x + box.width).toBeLessThanOrEqual(layer.x + layer.width);
    expect(box.y).toBeGreaterThanOrEqual(layer.y);
    expect(box.y + box.height).toBeLessThanOrEqual(layer.y + layer.height);
  };
  const dialog = page.getByRole("dialog", { name: /Conflict:/ });
  await insideLayer(dialog);
  await insideLayer(dialog.locator(".actions"));
  await dialog.getByRole("button", { name: "Pause one side" }).click();
  const menu = dialog.getByRole("menu");
  await insideLayer(menu);
  await menu.getByRole("menuitem").filter({ hasNot: page.locator(".noop") }).first().click();
  await insideLayer(page.getByRole("region", { name: "Conflict intervention receipt" }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(760);
});

for (const viewport of [{ width: 900, height: 700 }, { width: 760, height: 700 }]) {
  test(`compact drag and keyboard movement stay canvas-bounded at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installProductionHost(page);
    await openProduction(page);
    const { signal } = await openSignal(page);
    const handle = signal.getByRole("button", { name: "Move conflict signal" });
    const canvas = (await page.locator(".canvas").boundingBox())!;
    const box = (await signal.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 12);
    await handle.dispatchEvent("pointerdown", { button: 0, pointerId: 1, clientX: box.x + 12, clientY: box.y + 12 });
    await handle.dispatchEvent("pointermove", { pointerId: 1, clientX: -200, clientY: -200 });
    await handle.dispatchEvent("pointerup", { pointerId: 1, clientX: -200, clientY: -200 });
    await handle.focus();
    await handle.press("ArrowRight");
    const moved = (await signal.boundingBox())!;
    expect(moved.x).toBeGreaterThanOrEqual(canvas.x + 8);
    expect(moved.y).toBeGreaterThanOrEqual(canvas.y + 8);
    expect(moved.x + moved.width).toBeLessThanOrEqual(canvas.x + canvas.width - 7);
    expect(moved.y + moved.height).toBeLessThanOrEqual(canvas.y + canvas.height - 7);
    await expect(signal).toHaveCSS("animation-name", "none");
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}
