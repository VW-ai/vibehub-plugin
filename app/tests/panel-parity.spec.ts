import { BASE } from "./env";
/**
 * task-panel S4 screenshot-parity capture (LOOP.md S4 mechanical gate):
 * the React panel (opened the REAL way — clicking the "Refactor auth flow"
 * card on v8-baseline) next to the frozen S2 static, at 1280×800 + 1440×900,
 * plus an expanded-state shot (files burst + transcript tail open) and one
 * extreme (?panel=marathon dev param). Deltas documented in
 * notes/task-panel.md (§S4 parity deltas).
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../notes/shots");
const S2_STATIC = resolve(HERE, "../static/task-panel-s2.html");

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Let entry + panel animations finish. */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

/** Open v8-baseline and click the waiting card — the real integration path. */
async function openPanelViaCard(page: Page) {
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
  await settle(page);
  await page.locator('[data-task="task-refactor-auth"]').click();
  await expect(page.locator(".panel")).toBeVisible();
  // park the pointer on the titlebar lights (no data-tip) so the scrim's
  // tooltip doesn't fire while the shot is taken
  await page.mouse.move(40, 20);
  await page.waitForTimeout(400); // slide-in 200ms + settle
}

test("react panel (refactor-auth via card click) @1280x800", async ({ page }) => {
  await openPanelViaCard(page);
  await page.screenshot({ path: `${SHOTS}/task-panel-s4-1280.png` });
});

test("react panel @1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPanelViaCard(page);
  await page.screenshot({ path: `${SHOTS}/task-panel-s4-1440.png` });
});

test("react panel expanded (files burst + transcript tail) @1280x800", async ({ page }) => {
  await openPanelViaCard(page);
  await page.locator(".filestoggle").click();
  await page.locator(".actions .quiet", { hasText: "View transcript" }).click();
  await expect(page.locator(".tail")).toBeVisible();
  await page.mouse.move(40, 20); // park: no tooltip in the shot
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/task-panel-s4-1280-expanded.png` });
});

test("react panel extreme via ?panel=marathon @1280x800", async ({ page }) => {
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0&panel=marathon`);
  await settle(page);
  await expect(page.locator(".panel")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/task-panel-s4-marathon-1280.png` });
});

test("s2 static reference @1280x800 (regenerated alongside)", async ({ page }) => {
  await page.goto(pathToFileURL(S2_STATIC).href);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/task-panel-s4-static-ref-1280.png` });
});
