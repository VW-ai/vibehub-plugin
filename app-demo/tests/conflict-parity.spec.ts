/**
 * conflict-card S4 screenshot-parity capture (LOOP.md S4 mechanical gate):
 * the React card next to the frozen S2 static, red/yellow/empty ×
 * 1280×800 + 1440×900. Red opens the REAL way (rail CONFLICT pill on
 * v8-baseline); yellow/empty via the ?conflict= dev param (their conflicts
 * don't exist on any map fixture). Modal-only element shots are captured
 * alongside for a like-for-like diff (the full-page underlay legitimately
 * differs: the app has the rail + live map; the static a hand-simplified
 * canvas). Deltas documented in notes/conflict-card.md (§S4 parity deltas).
 *
 * Plus S4 integration smoke: all three open paths, close/focus-return, and
 * the panel↔card mutual exclusivity (iter-12 fork), and a zero-console-error
 * sweep across all five ?conflict= fixtures.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, "../notes/shots");
const S2_STATIC = resolve(HERE, "../static/conflict-card-s2.html");

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

/** Let entry + card animations finish. */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

/** Park the pointer on the titlebar lights so no tooltip is in the shot. */
async function park(page: Page) {
  await page.mouse.move(40, 20);
  await page.waitForTimeout(400);
}

/** Open the red card the REAL way: rail CONFLICT pill on v8-baseline. */
async function openRedViaPill(page: Page) {
  await page.goto("http://localhost:5199/?fixture=v8-baseline&switcher=0");
  await settle(page);
  await page.locator('[data-task="task-auto-retry-payments"] .pill').click();
  await expect(page.locator(".modal")).toBeVisible();
  await park(page);
}

async function openViaParam(page: Page, name: string) {
  await page.goto(
    `http://localhost:5199/?fixture=v8-baseline&switcher=0&conflict=${name}`,
  );
  await settle(page);
  await expect(page.locator(".modal")).toBeVisible();
  await park(page);
}

/* ── parity shots ─────────────────────────────────────────────────────── */

test("red (via rail CONFLICT pill) @1280x800", async ({ page }) => {
  await openRedViaPill(page);
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-red-1280x800.png` });
  await page
    .locator(".modal")
    .screenshot({ path: `${SHOTS}/conflict-card-s4-modal-red-1280.png` });
});

test("red @1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRedViaPill(page);
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-red-1440x900.png` });
});

test("yellow (?conflict=yellow-stale) @1280x800", async ({ page }) => {
  await openViaParam(page, "yellow-stale");
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-yellow-1280x800.png` });
  await page
    .locator(".modal")
    .screenshot({ path: `${SHOTS}/conflict-card-s4-modal-yellow-1280.png` });
});

test("yellow @1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViaParam(page, "yellow-stale");
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-yellow-1440x900.png` });
});

test("empty (?conflict=no-diagnosis) @1280x800", async ({ page }) => {
  await openViaParam(page, "no-diagnosis");
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-empty-1280x800.png` });
  await page
    .locator(".modal")
    .screenshot({ path: `${SHOTS}/conflict-card-s4-modal-empty-1280.png` });
});

test("empty @1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openViaParam(page, "no-diagnosis");
  await page.screenshot({ path: `${SHOTS}/conflict-card-s4-empty-1440x900.png` });
});

test("s2 static modal refs (red/yellow/empty) @1280x800", async ({ page }) => {
  for (const [v, name] of [
    ["", "red"],
    ["yellow", "yellow"],
    ["empty", "empty"],
  ] as const) {
    await page.goto(`${pathToFileURL(S2_STATIC).href}?dev=0&v=${v}`);
    await settle(page);
    await page.locator(".modal:visible").screenshot({
      path: `${SHOTS}/conflict-card-s4-static-modal-${name}-1280.png`,
    });
  }
});

/* ── S4 integration smoke (mechanical wiring checks) ──────────────────── */

test("all three open paths + focus returns to each opener", async ({ page }) => {
  await page.goto("http://localhost:5199/?fixture=v8-baseline&switcher=0");
  await settle(page);

  // path #2: rail CONFLICT pill; Escape returns focus to the pill
  const pill = page.locator('[data-task="task-auto-retry-payments"] .pill');
  await pill.click();
  await expect(page.locator(".modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(pill).toBeFocused();

  // path #1: map sub-block clash chip; X-close returns focus to the chip
  const chip = page.locator(".sub.clash");
  await chip.click();
  await expect(page.locator(".modal")).toBeVisible();
  await page.locator(".modal .pclose").click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(chip).toBeFocused();

  // path #3: titlebar conflict stat (keyboard: Enter opens, scrim closes)
  const stat = page.locator(".stat.clash");
  await stat.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toBeVisible();
  await page.locator(".scrim").click({ position: { x: 20, y: 200 } });
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(stat).toBeFocused();
});

test("conflict card and task panel are mutually exclusive", async ({ page }) => {
  await page.goto("http://localhost:5199/?fixture=v8-baseline&switcher=0");
  await settle(page);

  // panel open → opening the conflict closes the panel
  await page.locator('[data-task="task-refactor-auth"]').click();
  await expect(page.locator(".panel")).toBeVisible();
  // the pill sits under the scrim while the panel is open — close first is
  // NOT required from the titlebar stat (it stays above the scrim's z-order
  // within the titlebar, outside .main)
  await page.locator(".stat.clash").click();
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page.locator(".panel")).toHaveCount(0);

  // conflict open → opening a task (via a side row) closes the conflict
  await page.locator(".side").first().click();
  await expect(page.locator(".panel")).toBeVisible();
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("escape with the pause menu open closes the menu, not the card", async ({ page }) => {
  await openViaParam(page, "yellow-stale");
  await page.locator(".split > button").click();
  await expect(page.locator(".pmenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".pmenu")).toHaveCount(0);
  await expect(page.locator(".modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("S2 behaviors survive dynamization (stale marker, seams, autogrow, mono backticks, no-op row)", async ({ page }) => {
  await openViaParam(page, "yellow-stale");

  // staleness honesty: neutral dot + "· 3 edits since" (fixture's own touches)
  await expect(page.locator(".prov.stale")).toHaveCount(1);
  await expect(page.locator(".prov .edits")).toHaveText("· 3 edits since");

  // backtick tokens render mono (iter-11 fork #4): resolve() twice in yellow
  const code = page.locator(".verdict .code");
  await expect(code).toHaveCount(2);
  const font = await code.first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toContain("ui-monospace");

  // scroll-aware seams: yellow@1280 clips → footer casts up; after scrolling
  // to the bottom the grade casts down and the footer seam goes off
  const body = page.locator(".cbody");
  await expect(page.locator(".cfoot.seam")).toHaveCount(1);
  await expect(page.locator(".grade.seam")).toHaveCount(0);
  await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await expect(page.locator(".grade.seam")).toHaveCount(1);
  await expect(page.locator(".cfoot.seam")).toHaveCount(0);

  // inject textarea autogrows 52 → 124 cap, then returns to the floor
  const note = page.locator(".cfoot textarea");
  const h0 = await note.evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(h0)).toBe(52);
  await note.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
  const h1 = await note.evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(h1)).toBe(124);
  await note.fill("");
  const h2 = await note.evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.round(h2)).toBe(52);

  // empty-note contract: diagnosed placeholder promises the send-time default
  await expect(note).toHaveAttribute("placeholder", /leave empty to send the Suggested line/);

  // pause menu: waiting side = honest enabled no-op at secondary ink
  await page.locator(".split > button").click();
  const noop = page.locator(".pmenu button.noop");
  await expect(noop).toHaveCount(1);
  await expect(noop.locator(".st")).toHaveText("waiting 5m");
  await expect(noop).toBeEnabled();
  await noop.click(); // honest no-op — menu closes, card stays
  await expect(page.locator(".pmenu")).toHaveCount(0);
  await expect(page.locator(".modal")).toBeVisible();

  // no-diagnosis card: placeholder loses the default (nothing to default to)
  await openViaParam(page, "no-diagnosis");
  await expect(page.locator(".cfoot textarea")).toHaveAttribute(
    "placeholder",
    /one message, queued to both tasks/,
  );
});

test("all five ?conflict= fixtures render, zero console/page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  for (const name of [
    "osm-red-diagnosed",
    "no-diagnosis",
    "yellow-stale",
    "1200-symbols",
    "one-symbol",
  ]) {
    await page.goto(
      `http://localhost:5199/?fixture=v8-baseline&switcher=0&conflict=${name}`,
    );
    await settle(page);
    await expect(page.locator(".modal"), name).toBeVisible();
    // symbol expand smoke on the big ones (yields its space back on collapse)
    if (name === "1200-symbols") {
      await expect(page.locator(".cbody h4 .mono").first()).toHaveText("1.2k");
      await page.locator(".symtoggle").click();
      await expect(page.locator(".sym")).toHaveCount(1200);
      await page.locator(".symtoggle").click();
      await expect(page.locator(".sym")).toHaveCount(3);
    }
    if (name === "one-symbol") {
      await expect(page.locator(".sym")).toHaveCount(1);
      await expect(page.locator(".symtoggle")).toHaveCount(0);
      await expect(page.locator(".diag-empty")).toBeVisible();
    }
  }
  expect(errors, errors.join("\n")).toHaveLength(0);
});
