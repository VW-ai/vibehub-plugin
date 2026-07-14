import { BASE } from "./env";
/**
 * S4 screenshot-parity capture (LOOP.md mechanical gate):
 *  (a) React render of the v8-baseline fixture
 *  (b) the frozen static reference kept inside the publishable app subtree
 * both at 1280×800 (plus a 1440×900 React sanity shot and one shot per
 * extreme fixture so the scale paths demonstrably render).
 * Shots land in notes/shots/ and deltas are documented in notes/map-main.md.
 */
import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../notes/shots");
const V8_STATIC = resolve(HERE, "../test/assets/reference-screen-v8.html");

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Let entry animations finish (longest: territory .34s delay + .55s anim). */
async function settle(page: import("@playwright/test").Page) {
  await page.waitForTimeout(1200);
}

test("react v8-baseline @1280x800", async ({ page }) => {
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/react-v8-baseline-1280x800.png` });
});

test("static v8 reference @1280x800", async ({ page }) => {
  await page.goto(pathToFileURL(V8_STATIC).href);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/static-v8-reference-1280x800.png` });
});

test("react v8-baseline @1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/react-v8-baseline-1440x900.png` });
});

for (const fixture of ["empty-project", "scope-overload", "forty-territories"]) {
  test(`react extreme fixture ${fixture} @1280x800`, async ({ page }) => {
    await page.goto(`${BASE}/?fixture=${fixture}`);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/react-${fixture}-1280x800.png` });
  });
}
