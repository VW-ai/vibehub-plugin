/**
 * menubar S4 screenshot-parity capture + structure probes (LOOP.md S4 gate):
 * the React menubar surface next to the frozen S1+S2 static, all 5 variants
 * at 1280×800 (?menubar= dev param, switcher hidden). KNOWN deltas are
 * asserted, not just tolerated (notes/menubar.md §S4 deltas):
 *   1. conflict row age = detectedAt basis → busy/stale show "8m" (the
 *      static hand-wrote the older writer's 31m runtime; fork iter-20);
 *   2. flood ages obey the app-wide ONE-UNIT rule → "2h"/"1h" (the static
 *      hand-wrote compound "1h44m"/"1h12m", which derive.ts forbids);
 *   3. "2 conflicts" pluralized (static's "2 conflict" treated as a typo);
 *   4. clock derives from capturedAt ("Sun Jul 12  10:22") instead of the
 *      static's decorative "Fri Jul 11  09:41".
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../notes/shots");

const VARIANTS = ["busy", "quiet", "stale", "overload", "flood"] as const;

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Let the dropIn entry animation finish (200ms) + park the pointer. */
async function open(page: Page, variant: string) {
  await page.goto(`http://localhost:5199/?menubar=${variant}&switcher=0`);
  await page.locator(".drop").waitFor();
  await page.mouse.move(640, 500);
  await page.waitForTimeout(500);
}

/* ── parity shots: 5 variants × 1280×800 ──────────────────────────────── */

for (const v of VARIANTS) {
  test(`parity shot ${v} @1280x800`, async ({ page }) => {
    await open(page, v);
    await page.screenshot({ path: `${SHOTS}/menubar-s4-${v}-1280x800.png` });
  });
}

/* ── all 5 variants render with zero console/page errors ──────────────── */

test("all 5 ?menubar= variants render, zero console/page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const v of VARIANTS) {
    await open(page, v);
    await expect(page.locator(".vhitem"), v).toBeVisible();
    await expect(page.locator(".drop"), v).toBeVisible();
    await expect(page.locator(".rline .name"), v).toHaveText("VW-ai/Vibehub");
  }
  expect(errors, errors.join("\n")).toHaveLength(0);
});

/* ── per-variant structure: exactly the static's sections, from data ───── */

test("busy: counts, needs-you rows, KNOWN DELTA 1 (conflict age 8m)", async ({ page }) => {
  await open(page, "busy");
  await expect(page.locator(".fresh")).toHaveText(/Synced 42s ago/);
  await expect(page.locator(".stalenote")).toHaveCount(0);
  await expect(page.locator(".quietline")).toHaveCount(0);
  await expect(page.locator(".counts .stat")).toHaveText([
    "1 waiting",
    "1 conflict",
    "3 running",
  ]);
  await expect(page.locator(".gh")).toHaveText("Needs you 2");
  const rows = page.locator(".drop .item");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator(".pill")).toHaveText("WAITING");
  await expect(rows.nth(0).locator(".t")).toHaveText("Refactor auth flow");
  await expect(rows.nth(0).locator(".age")).toHaveText("12m");
  await expect(rows.nth(1).locator(".pill")).toHaveText("CONFLICT");
  await expect(rows.nth(1).locator(".t")).toHaveText("Order state machine — 2 writing");
  // DELTA 1: detectedAt basis (10:13:40 → 8m), not the static's 31m
  await expect(rows.nth(1).locator(".age")).toHaveText("8m");
  await expect(page.locator(".more")).toHaveCount(0);
  // DELTA 4: the desk clock derives from capturedAt
  await expect(page.locator(".clock")).toHaveText("Sun Jul 12  10:22");
});

test("quiet: no badge, alive-only counts, honest all-quiet line", async ({ page }) => {
  await open(page, "quiet");
  await expect(page.locator(".vhitem .badge")).toHaveCount(0);
  await expect(page.locator(".counts .stat")).toHaveText(["3 running"]);
  await expect(page.locator(".quietline")).toHaveText(
    /All quiet — 3 running, nothing needs you\./,
  );
  await expect(page.locator(".gh")).toHaveCount(0);
  await expect(page.locator(".drop .item")).toHaveCount(0);
  await expect(page.locator(".fresh")).toHaveText(/Synced 18s ago/);
});

test("stale: gray static badge, honesty line, last-known counts", async ({ page }) => {
  await open(page, "stale");
  const badge = page.locator(".vhitem .badge");
  await expect(badge).toHaveText("1");
  await expect(badge).toHaveClass(/stale/);
  // stale badge withholds the breathe animation (motion = live urgency)
  const anim = await badge.evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("none");
  await expect(page.locator(".fresh")).toHaveText(/Synced 47m ago/);
  await expect(page.locator(".fresh")).toHaveClass(/stale/);
  await expect(page.locator(".stalenote")).toHaveText(
    "Showing last known repo state — sessions still report via hooks. Open Vibehub to sync.",
  );
  await expect(page.locator(".counts .stat")).toHaveText([
    "1 waiting",
    "1 conflict",
    "3 running",
  ]);
  await expect(page.locator(".drop .item")).toHaveCount(2);
});

test("overload: top-3 oldest-first + 'and 9 more waiting…'", async ({ page }) => {
  await open(page, "overload");
  await expect(page.locator(".vhitem .badge")).toHaveText("12");
  await expect(page.locator(".counts .stat")).toHaveText(["12 waiting", "5 running"]);
  await expect(page.locator(".gh")).toHaveText("Needs you 12");
  const rows = page.locator(".drop .item");
  await expect(rows).toHaveCount(3);
  await expect(rows.locator(".age")).toHaveText(["52m", "47m", "41m"]);
  await expect(rows.nth(0).locator(".t")).toHaveText(
    "Reconcile invoice line items against the payments ledger export",
  );
  await expect(page.locator(".more")).toHaveText("and 9 more waiting…");
  // TEXT-long: the 64-char title actually ellipsizes at 340px
  const truncated = await rows
    .nth(0)
    .locator(".t")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated).toBe(true);
});

test("flood: 99+ cap, 145 needs-you, KNOWN DELTAS 2+3 (one-unit ages, plural)", async ({
  page,
}) => {
  await open(page, "flood");
  await expect(page.locator(".vhitem .badge")).toHaveText("99+");
  // DELTA 3: correct plural (the static's "2 conflict" was a typo)
  await expect(page.locator(".counts .stat")).toHaveText([
    "143 waiting",
    "2 conflicts",
    "31 running",
  ]);
  await expect(page.locator(".gh")).toHaveText("Needs you 145");
  const rows = page.locator(".drop .item");
  await expect(rows).toHaveCount(3);
  // DELTA 2: one-unit rule — 104m → "2h", 72m → "1h" (never "1h44m")
  await expect(rows.locator(".age")).toHaveText(["2h", "1h", "58m"]);
  await expect(rows.nth(1).locator(".pill")).toHaveText("CONFLICT");
  await expect(rows.nth(1).locator(".t")).toHaveText("Order state machine — 2 writing");
  // the hidden second conflict forces the generic overflow copy
  await expect(page.locator(".more")).toHaveText("and 142 more…");
});

/* ── geometry: anchored under the item, inside the viewport, no overflow ── */

for (const width of [1280, 1440] as const) {
  test(`dropdown anchored under the item @${width}, no page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 900 });
    await open(page, "busy");
    const item = await page.locator(".vhitem").boundingBox();
    const drop = await page.locator(".drop").boundingBox();
    expect(item && drop).toBeTruthy();
    if (!item || !drop) return;
    // horizontally anchored: the item's center sits within the dropdown's x-range
    const cx = item.x + item.width / 2;
    expect(cx).toBeGreaterThanOrEqual(drop.x);
    expect(cx).toBeLessThanOrEqual(drop.x + drop.width);
    // fully inside the viewport
    expect(drop.x).toBeGreaterThanOrEqual(0);
    expect(drop.x + drop.width).toBeLessThanOrEqual(width);
    expect(drop.y + drop.height).toBeLessThanOrEqual(width === 1280 ? 800 : 900);
    // no page scroll on either axis
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - window.innerWidth,
      y: document.documentElement.scrollHeight - window.innerHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
  });
}

/* ── the map/install paths are untouched by the menubar layer ──────────── */

test("unknown ?menubar= name falls through to the map path", async ({ page }) => {
  await page.goto("http://localhost:5199/?menubar=nope&fixture=v8-baseline&switcher=0");
  await page.waitForTimeout(1200);
  await expect(page.locator(".mbdesk")).toHaveCount(0);
  await expect(page.locator(".legend")).toBeVisible();
  await expect(page.locator(".terr")).not.toHaveCount(0);
});

test("?menubar=1 bare flag opens the busy variant", async ({ page }) => {
  await page.goto("http://localhost:5199/?menubar=1&switcher=0");
  await page.locator(".drop").waitFor();
  await expect(page.locator(".gh")).toHaveText("Needs you 2");
  await expect(page.locator(".vhitem .badge")).toHaveText("1");
});
