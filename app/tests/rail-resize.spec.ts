import { BASE } from "./env";
/**
 * rev-1 (Wayne verdict 2026-07-12) — Task B: resizable rail/canvas split.
 *
 * Covers: drag clamped to 240–480px, double-click reset to 300px,
 * localStorage persistence across reload, keyboard accessibility
 * (focusable separator, arrow keys ±16px), and the live chip-wrap
 * response at both clamp extremes (flex re-wraps; all chips stay
 * visible; narrower rail → more rows).
 */
import { expect, test, type Page } from "@playwright/test";

/** Let entry animations finish (longest: territory .34s delay + .55s anim). */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

async function open(page: Page, fixture: string) {
  await page.goto(`${BASE}/?fixture=${fixture}`);
  await settle(page);
}

async function railWidth(page: Page): Promise<number> {
  const box = await page.locator(".rail").boundingBox();
  return box!.width;
}

/** Drag the divider horizontally by `dx` pixels with real pointer events. */
async function dragDivider(page: Page, dx: number) {
  const divider = page.locator(".divider");
  const box = (await divider.boundingBox())!;
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + dx, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("resizable rail/canvas split", () => {
  test("divider drags the rail wider and the canvas yields", async ({ page }) => {
    await open(page, "v8-baseline");
    expect(await railWidth(page)).toBe(300); // default = v8's fixed width
    const canvasBefore = (await page.locator(".canvas").boundingBox())!;
    await dragDivider(page, 100);
    expect(await railWidth(page)).toBe(400);
    const canvasAfter = (await page.locator(".canvas").boundingBox())!;
    expect(Math.round(canvasBefore.width - canvasAfter.width)).toBe(100);
  });

  test("drag clamps at min 240px and max 480px", async ({ page }) => {
    await open(page, "v8-baseline");
    await dragDivider(page, -400); // way past the minimum
    expect(await railWidth(page)).toBe(240);
    await dragDivider(page, 600); // way past the maximum
    expect(await railWidth(page)).toBe(480);
  });

  test("double-click resets to 300px", async ({ page }) => {
    await open(page, "v8-baseline");
    await dragDivider(page, 120);
    expect(await railWidth(page)).toBe(420);
    await page.locator(".divider").dblclick();
    expect(await railWidth(page)).toBe(300);
  });

  test("chosen width persists across reload (localStorage)", async ({ page }) => {
    await open(page, "v8-baseline");
    await dragDivider(page, -40);
    expect(await railWidth(page)).toBe(260);
    await page.reload();
    await settle(page);
    expect(await railWidth(page)).toBe(260);
  });

  test("keyboard: divider is focusable; arrows nudge ±16px and clamp", async ({ page }) => {
    await open(page, "v8-baseline");
    const divider = page.locator(".divider");
    await divider.focus();
    await expect(divider).toBeFocused();
    // separator semantics exposed for AT
    await expect(divider).toHaveAttribute("role", "separator");
    await expect(divider).toHaveAttribute("aria-valuenow", "300");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await railWidth(page)).toBe(332);
    await expect(divider).toHaveAttribute("aria-valuenow", "332");
    await page.keyboard.press("ArrowLeft");
    expect(await railWidth(page)).toBe(316);
    // clamp at the minimum via keyboard alone
    for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft");
    expect(await railWidth(page)).toBe(240);
    await expect(divider).toHaveAttribute("aria-valuenow", "240");
  });

  test("chip wrap responds live to rail width (240px vs 480px)", async ({ page }) => {
    await open(page, "scope-overload");
    const card = page.locator('[data-task="task-nine-scopes"]');
    // narrow extreme: all 10 chips visible, many rows
    await dragDivider(page, -300);
    expect(await railWidth(page)).toBe(240);
    await expect(card.locator(".chip")).toHaveCount(10);
    const narrowRow = (await card.locator(".row2").boundingBox())!;
    const cardBoxNarrow = (await card.boundingBox())!;
    for (const chip of await card.locator(".chip").all()) {
      const b = (await chip.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(
        cardBoxNarrow.x + cardBoxNarrow.width + 0.5,
      );
    }
    // wide extreme: same 10 chips, fewer rows — the card gives space back
    await dragDivider(page, 400);
    expect(await railWidth(page)).toBe(480);
    await expect(card.locator(".chip")).toHaveCount(10);
    const wideRow = (await card.locator(".row2").boundingBox())!;
    expect(wideRow.height).toBeLessThan(narrowRow.height);
    // both extremes still wrap or fit — never a clipped single line
    expect(wideRow.height).toBeGreaterThanOrEqual(16);
  });

  test("default width leaves v8 geometry untouched (fresh context = 300px)", async ({ page }) => {
    await open(page, "v8-baseline");
    expect(await railWidth(page)).toBe(300);
    // divider straddles the rail border with net-zero layout: canvas starts
    // where it always did (rail right edge)
    const rail = (await page.locator(".rail").boundingBox())!;
    const canvas = (await page.locator(".canvas").boundingBox())!;
    expect(Math.abs(canvas.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
  });
});
