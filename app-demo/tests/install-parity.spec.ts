import { BASE } from "./env";
/**
 * empty-install S4 screenshot-parity capture + integration smoke
 * (LOOP.md S4 mechanical gate): the React first-run screen next to the
 * frozen S2 static, all 8 original variants × 1280×800 + 1440×900
 * (?install= dev param, switcher hidden). Two KNOWN deltas are asserted,
 * not just tolerated (notes/empty-install.md §S4 deltas):
 *   1. two-tasks x-order — the WRITTEN oldest-first rule puts
 *      request-tracing at the origin (S2 hand-drew health-check there);
 *   2. first-task-200 — packed dims 53.7×58.2 (derived) vs hand-drawn 58×58.
 * Plus: all 10 ?install= fixtures render with zero console/page errors,
 * packing probes (inside-territory, no overlap, +N chip), the storyboarded
 * CTA installing→connected hard-swap, the failed-step Retry path, and the
 * Moment A autofocus keyboard path.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../notes/shots");

const VARIANTS = [
  "connect",
  "installing",
  "install-failed",
  "connected",
  "mapping",
  "first-task",
  "two-tasks",
  "first-task-200",
] as const;

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Let entry animations finish (longest: winIn .5s). */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

/** Park the pointer on the titlebar lights so no tooltip is in the shot. */
async function park(page: Page) {
  await page.mouse.move(40, 20);
  await page.waitForTimeout(400);
}

async function open(page: Page, name: string) {
  await page.goto(`${BASE}/?install=${name}&switcher=0`);
  await settle(page);
  await park(page);
}

/* ── parity shots: 8 original S2 variants × both viewports ────────────── */

for (const v of VARIANTS) {
  test(`parity shots ${v} @1280x800 + @1440x900`, async ({ page }) => {
    await open(page, v);
    await page.screenshot({ path: `${SHOTS}/empty-install-s4-${v}-1280x800.png` });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, v);
    await page.screenshot({ path: `${SHOTS}/empty-install-s4-${v}-1440x900.png` });
  });
}

/* ── all 10 fixtures render, zero console/page errors ─────────────────── */

test("all 10 ?install= fixtures render, zero console/page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const name of [...VARIANTS, "nine-footprints", "tiny-repo"]) {
    await page.goto(`${BASE}/?install=${name}&switcher=0`);
    await settle(page);
    if (name === "connect" || name === "installing" || name === "install-failed") {
      await expect(page.locator(".connect"), name).toBeVisible();
      await expect(page.locator(".terr"), name).toHaveCount(0);
    } else {
      await expect(page.locator(".terr.quiet"), name).toBeVisible();
      await expect(page.locator(".connect"), name).toHaveCount(0);
    }
  }
  expect(errors, errors.join("\n")).toHaveLength(0);
});

/* ── per-variant structure probes (statuses come from the fixture) ────── */

test("installing/install-failed checklists render fixture statuses", async ({ page }) => {
  await open(page, "installing");
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(1);
  await expect(page.locator('.step[data-status="now"] .busy')).toBeVisible();
  await expect(page.locator('.step[data-status="pending"]')).toHaveCount(1);
  // 150-char path: leading-ellipsis truncation actually active
  const truncated = await page
    .locator(".path .p")
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(truncated).toBe(true);

  await open(page, "install-failed");
  await expect(page.locator('.step[data-status="failed"] .st.fail')).toHaveText("failed");
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(2);
  await expect(page.locator(".why code")).toHaveText("~/.claude/settings.json");
  await expect(page.locator(".why .retry")).toBeVisible();
  await expect(page.locator(".connect .local")).toContainText(
    "2 of 3 done. Sessions won't report until hooks install.",
  );
});

test("connected/mapping: zero-groups, guidance, MappingRun chip state", async ({ page }) => {
  await open(page, "connected");
  await expect(page.locator(".group.zero")).toHaveCount(3);
  await expect(page.locator(".task")).toHaveCount(0);
  await expect(page.locator(".guide p")).toBeVisible();
  await expect(page.locator(".guide .mapbtn")).toHaveText("Map this repo");
  await expect(page.locator(".repo")).toContainText("acme/greenfield");
  await expect(page.locator(".fresh")).toHaveText(/Synced just now/);
  await expect(page.locator(".stat")).toHaveCount(0); // zero-count stats hidden

  // Map-this-repo demo: button yields in place to the honest status chip
  await page.locator(".guide .mapbtn").click();
  await expect(page.locator(".guide .mapstat")).toContainText("Mapping this repo");
  // …and clicking the chip stops the pass (tooltip promise: no dead pixels)
  await page.locator(".guide .mapstat").click();
  await expect(page.locator(".guide .mapbtn")).toBeVisible();

  await open(page, "mapping");
  await expect(page.locator(".guide .mapstat")).toContainText("Mapping this repo");
  await expect(page.locator(".guide .mapstat .t")).toHaveText("2m");
});

test("first-task: rail card + floor footprint from packFootprints", async ({ page }) => {
  await open(page, "first-task");
  await expect(page.locator(".task")).toHaveCount(1);
  await expect(page.locator(".task .pill.alive")).toHaveText("RUNNING");
  await expect(page.locator(".stat.alive")).toHaveText("1 running");
  const fp = page.locator(".fp");
  await expect(fp).toHaveCount(1);
  // toBeVisible, not just toHaveText: the panel's bare `.files{display:none}`
  // swallowed this once (hidden text still satisfies toHaveText)
  await expect(fp.locator(".files")).toBeVisible();
  await expect(fp.locator(".files")).toHaveText("3 files · not yet mapped to features");
  await expect(fp.locator(".who")).toBeVisible();
  // the derived rect degenerates to S1/S2's hand-drawn floor block EXACTLY
  const style = await fp.getAttribute("style");
  expect(style).toContain("left: 6%");
  expect(style).toContain("top: 58%");
  expect(style).toContain("width: 24%");
  expect(style).toContain("height: 26%");
  // corner map action stays reachable
  await expect(page.locator(".mapbtn.corner")).toBeVisible();
});

test("two-tasks: KNOWN DELTA 1 — oldest-first origin + no overlap, inside territory", async ({
  page,
}) => {
  await open(page, "two-tasks");
  await expect(page.locator(".fp")).toHaveCount(2);
  const terr = await page.locator(".terr.quiet").boundingBox();
  const tracing = await page.locator('[data-fp="install-task-tracing"]').boundingBox();
  const health = await page.locator('[data-fp="install-task-health"]').boundingBox();
  expect(terr && tracing && health).toBeTruthy();
  if (!terr || !tracing || !health) return;
  // the written rule wins over the S2 hand placement: tracing (11m, older)
  // sits at the bottom-left origin, health-check to its right
  expect(tracing.x).toBeLessThan(health.x);
  // both inside the territory, no overlap
  for (const b of [tracing, health]) {
    expect(b.x).toBeGreaterThanOrEqual(terr.x - 1);
    expect(b.y).toBeGreaterThanOrEqual(terr.y - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(terr.x + terr.width + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(terr.y + terr.height + 1);
  }
  const overlapX = tracing.x < health.x + health.width && health.x < tracing.x + tracing.width;
  const overlapY = tracing.y < health.y + health.height && health.y < tracing.y + tracing.height;
  expect(overlapX && overlapY).toBe(false);
});

test("first-task-200: KNOWN DELTA 2 — derived 53.7×58.2 (not the hand-drawn 58×58)", async ({
  page,
}) => {
  await open(page, "first-task-200");
  const style = await page.locator(".fp").getAttribute("style");
  // 200/640 = 31.25% area → sqrt-damped from the 24×26 floor
  expect(style).toMatch(/width: 53\.7\d*%/);
  expect(style).toMatch(/height: 58\.1\d*%/);
  await expect(page.locator(".fp .files")).toBeVisible();
  await expect(page.locator(".fp .files")).toHaveText(
    "200 files · not yet mapped to features",
  );
});

test("nine-footprints extreme: 6 visible + '+3 earlier sessions' chip", async ({ page }) => {
  await open(page, "nine-footprints");
  await expect(page.locator(".fp")).toHaveCount(6);
  await expect(page.locator(".fp-chip")).toHaveText("+3 earlier sessions");
});

/* ── the storyboarded hard-swap transition (demo CTA click path) ──────── */

test("CTA path: connect → installing → all-done hold → card exits → connected chrome", async ({
  page,
}) => {
  await open(page, "connect");
  // Moment A keyboard path (iter-15 fork): the CTA autofocuses on mount
  await expect(page.locator(".cta")).toBeFocused();
  await page.keyboard.press("Enter"); // Enter-to-connect
  // fixture hard-swaps to installing: picked path + mid-flight checklist
  await expect(page.locator(".path")).toBeVisible();
  await expect(page.locator(".cta")).toHaveCount(0);
  // demo steps advance to all-done (t=0 of the storyboard: last check lands)
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(3, { timeout: 5000 });
  // hold 400ms → exit class (reverse cardIn, 200ms)
  await expect(page.locator(".connect.out")).toBeVisible({ timeout: 1500 });
  // hard swap: connected chrome enters (repo chip, zero-groups, launch, gray)
  await expect(page.locator(".terr.quiet")).toBeVisible({ timeout: 1500 });
  await expect(page.locator(".connect")).toHaveCount(0);
  await expect(page.locator(".repo")).toContainText("acme/greenfield");
  await expect(page.locator(".launch")).toBeVisible();
  await expect(page.locator(".group.zero")).toHaveCount(3);
  // the URL dev param followed the demo (reload lands on connected)
  expect(page.url()).toContain("install=connected");
});

test("Retry path: failed step reruns alone, then the same storyboard completes", async ({
  page,
}) => {
  await open(page, "install-failed");
  await page.locator(".retry").click();
  // ONLY the failed step reruns — the two done steps stay done
  await expect(page.locator('.step[data-status="now"] .busy')).toBeVisible();
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(2);
  await expect(page.locator(".why")).toHaveCount(0);
  // …then completes into the connected swap
  await expect(page.locator(".terr.quiet")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".connect")).toHaveCount(0);
});

/* ── the mapped-repo path is untouched by the install layer ───────────── */

test("unknown ?install= name falls through to the map path", async ({ page }) => {
  await page.goto(`${BASE}/?install=nope&fixture=v8-baseline&switcher=0`);
  await settle(page);
  await expect(page.locator(".connect")).toHaveCount(0);
  await expect(page.locator(".legend")).toBeVisible();
  await expect(page.locator(".terr")).not.toHaveCount(0);
});
