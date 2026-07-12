/**
 * menubar S5 interaction/state suite (LOOP.md S5 gate):
 *  - item click closes/reopens the dropdown (starts open — the demo subject);
 *  - Escape + outside-click close WITH focus return to the item;
 *  - selecting anything inside (row / stat / more / footer) closes like a
 *    real menu selection, focus back on the item;
 *  - badge presence/cap/staleness per variant;
 *  - needs-you rows carry the click intent in their tooltip (demo has no
 *    main window to open — fork iter-20);
 *  - tooltip honors the 260ms intent delay (nothing early, instant hide);
 *  - keyboard: dropdown rows are tabbable, Enter selects.
 */
import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, variant = "busy") {
  await page.goto(`http://localhost:5199/?menubar=${variant}&switcher=0`);
  await page.locator(".drop").waitFor();
}

/* ── open / close paths ─────────────────────────────────────────────────── */

test("item click closes, click again reopens (aria-expanded tracks)", async ({ page }) => {
  await open(page, "busy");
  await expect(page.locator(".vhitem")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".vhitem")).toHaveClass(/open/);
  await page.locator(".vhitem").click();
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".vhitem")).not.toHaveClass(/open/);
  await page.locator(".vhitem").click();
  await expect(page.locator(".drop")).toBeVisible();
  await expect(page.locator(".vhitem")).toHaveAttribute("aria-expanded", "true");
});

test("Escape closes and returns focus to the item", async ({ page }) => {
  await open(page, "busy");
  await page.locator(".drop .item").first().focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toBeFocused();
});

test("outside click (the desktop) closes and returns focus to the item", async ({ page }) => {
  await open(page, "busy");
  await page.mouse.click(300, 400); // wallpaper, far from strip + dropdown
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toBeFocused();
});

test("clicks INSIDE the dropdown do not close it (only selections do)", async ({ page }) => {
  await open(page, "busy");
  await page.locator(".rline .name").click(); // non-button repo name
  await expect(page.locator(".drop")).toBeVisible();
});

/* ── selection = close (the intent lives in the tooltip) ────────────────── */

for (const sel of [
  [".drop .item >> nth=0", "needs-you row"],
  [".counts .stat >> nth=0", "stat pill"],
  [".open-app", "Open Vibehub"],
  [".start-task", "Start a task"],
] as const) {
  test(`selecting the ${sel[1]} closes the menu, focus back on the item`, async ({ page }) => {
    await open(page, "busy");
    await page.locator(sel[0]).click();
    await expect(page.locator(".drop")).toHaveCount(0);
    await expect(page.locator(".vhitem")).toBeFocused();
  });
}

test("the overflow line is a selection too (overload)", async ({ page }) => {
  await open(page, "overload");
  await expect(page.locator(".more")).toHaveAttribute("data-tip", /full Needs-you list/);
  await page.locator(".more").click();
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toBeFocused();
});

/* ── badge per variant: presence, cap, staleness, the ONE animation ─────── */

test("badge matrix: busy 1 (breathing) / quiet none / stale gray-static / overload 12 / flood 99+", async ({
  page,
}) => {
  await open(page, "busy");
  const badge = page.locator(".vhitem .badge");
  await expect(badge).toHaveText("1");
  await expect(badge).not.toHaveClass(/stale/);
  expect(await badge.evaluate((el) => getComputedStyle(el).animationName)).toBe("breathe");

  await open(page, "quiet");
  await expect(page.locator(".vhitem .badge")).toHaveCount(0);

  await open(page, "stale");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveClass(/stale/);
  expect(await badge.evaluate((el) => getComputedStyle(el).animationName)).toBe("none");

  await open(page, "overload");
  await expect(badge).toHaveText("12");

  await open(page, "flood");
  await expect(badge).toHaveText("99+");
  // honesty when capped: the exact count travels in the tips
  await expect(badge).toHaveAttribute("data-tip", /143 tasks waiting/);
  await expect(page.locator(".vhitem")).toHaveAttribute("data-tip", /143 tasks waiting/);
});

/* ── click intent on needs-you rows (every variant that has rows) ───────── */

for (const v of ["busy", "stale", "overload", "flood"] as const) {
  test(`needs-you rows carry click intent tooltips (${v})`, async ({ page }) => {
    await open(page, v);
    const rows = page.locator(".drop .item");
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const tip = await rows.nth(i).getAttribute("data-tip");
      expect(tip, `${v} row ${i}`).toMatch(/Opens the adjudication card|opens the main window/);
    }
  });
}

test("conflict row tooltip names BOTH tasks of the pair (busy)", async ({ page }) => {
  await open(page, "busy");
  const row = page.locator('.drop .item[data-kind="conflict"]');
  await expect(row).toHaveAttribute(
    "data-tip",
    /'Auto-retry failed payments' and 'Cancel orders on timeout'/,
  );
});

/* ── tooltip: 260ms intent delay, instant hide ──────────────────────────── */

test("tooltip honors the 260ms intent delay on dropdown rows", async ({ page }) => {
  await open(page, "busy");
  const row = page.locator(".drop .item").first();
  await row.hover();
  await page.waitForTimeout(80);
  await expect(page.locator("#tip")).not.toHaveClass(/on/); // too early
  await page.waitForTimeout(320);
  await expect(page.locator("#tip")).toHaveClass(/on/);
  await expect(page.locator("#tip")).toContainText("Refactor auth flow");
  await expect(page.locator("#tip")).toContainText("opens the main window");
  await page.mouse.move(300, 500); // leave → instant hide
  await expect(page.locator("#tip")).not.toHaveClass(/on/);
});

test("every text leaf in the dropdown sits under a [data-tip] ancestor", async ({ page }) => {
  for (const v of ["busy", "quiet", "stale", "overload", "flood"]) {
    await open(page, v);
    const orphans = await page.locator(".drop").evaluate((drop) => {
      const bad: string[] = [];
      const walker = document.createTreeWalker(drop, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent?.trim();
        if (!text) continue;
        if (!(node.parentElement as HTMLElement | null)?.closest("[data-tip]"))
          bad.push(text);
      }
      return bad;
    });
    expect(orphans, `${v}: ${orphans.join(" | ")}`).toHaveLength(0);
  }
});

/* ── keyboard: rows tabbable, Enter selects ─────────────────────────────── */

test("keyboard path: Tab reaches stats, rows, overflow and footer; Enter selects", async ({
  page,
}) => {
  await open(page, "overload");
  await page.locator(".vhitem").focus();
  // DOM order after the item: dropdown buttons (stats → rows → more → footer)
  const expected = [
    ".counts .stat >> nth=0",
    ".counts .stat >> nth=1",
    ".drop .item >> nth=0",
    ".drop .item >> nth=1",
    ".drop .item >> nth=2",
    ".more",
    ".open-app",
    ".start-task",
  ];
  for (const sel of expected) {
    await page.keyboard.press("Tab");
    await expect(page.locator(sel)).toBeFocused();
  }
  // Enter on a focused row = selection: closes, focus returns to the item
  await page.locator(".drop .item >> nth=0").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toBeFocused();
});

/* ── reopening after close re-anchors under the item ────────────────────── */

test("reopen after close: dropdown re-anchors under the item", async ({ page }) => {
  await open(page, "busy");
  await page.keyboard.press("Escape");
  await expect(page.locator(".drop")).toHaveCount(0);
  await expect(page.locator(".vhitem")).toBeFocused(); // rAF focus return lands
  await page.keyboard.press("Enter"); // item is focused — keyboard reopen
  await expect(page.locator(".drop")).toBeVisible();
  const item = await page.locator(".vhitem").boundingBox();
  const drop = await page.locator(".drop").boundingBox();
  if (!item || !drop) throw new Error("missing boxes");
  const cx = item.x + item.width / 2;
  expect(cx).toBeGreaterThanOrEqual(drop.x);
  expect(cx).toBeLessThanOrEqual(drop.x + drop.width);
});
