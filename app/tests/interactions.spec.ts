import { BASE } from "./env";
/**
 * S5 interaction + state suite (LOOP.md mechanical gate for stage exit).
 *
 * Covers: correlate-hover (rail card → footprint lit, rest dimmed to .14,
 * rail dims, reset on leave), reverse correlate (territory → hot rail
 * cards), legend filters (all 4 kinds light the exact territory set AND
 * rail cards), tooltip semantics (260ms intent delay, bottom-edge flip,
 * exact value behind abbreviated 100k), chip wrap + middle truncation +
 * pathological +N (rev-1, Wayne verdict 2026-07-12), fixture
 * switcher, five-states presence, keyboard parity for hover paths, and
 * overlap/clipping checks at 1280×800 + 1440×900 on v8-baseline AND
 * forty-territories (this is the regression net for the legend-over-
 * bottom-row bug fixed by the density legend band in MapCanvas).
 *
 * All expected sets below are hand-derived from src/fixtures/* — if a
 * fixture changes, these literals must change with it (that is the point:
 * the derivation rules in derive.ts are product rules now).
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

/** Park the pointer somewhere inert so no hover state leaks between steps. */
async function parkMouse(page: Page) {
  await page.locator(".wordmark").hover();
  await page.waitForTimeout(300); // let the .2s opacity transitions finish
}

async function litTerritories(page: Page): Promise<string[]> {
  return (
    await page.locator(".terr.lit").evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.territory ?? ""),
    )
  ).sort();
}

async function hotTasks(page: Page): Promise<string[]> {
  return (
    await page.locator(".task.hot").evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.task ?? ""),
    )
  ).sort();
}

/* ── correlate-hover: rail card → map ──────────────────────────────────── */

// Footprint = declared scopes' territories + conflict territories
// (highlightForTask). Hand-derived from fixtures/v8-baseline.ts.
const FOOTPRINTS: Record<string, string[]> = {
  "task-refactor-auth": ["t-auth", "t-store"],
  "task-auto-retry-payments": ["t-ci", "t-notify", "t-pay"],
  "task-cancel-orders": ["t-pay", "t-store"],
  "task-migrate-sqlite": ["t-ci", "t-store"],
  "task-e2e-smoke": ["t-ci"],
  "task-reconnect-sse": ["t-fe"],
};

test.describe("correlate-hover (rail → map, v8-baseline)", () => {
  for (const [taskId, footprint] of Object.entries(FOOTPRINTS)) {
    test(`hover ${taskId} lights exactly ${footprint.join("+")}`, async ({ page }) => {
      await open(page, "v8-baseline");
      await page.locator(`[data-task="${taskId}"]`).hover();
      await expect(page.locator(".canvas")).toHaveClass(/focus/);
      await expect(page.locator(".rail")).toHaveClass(/dim/);
      expect(await litTerritories(page)).toEqual(footprint);
      // every non-lit territory dims to exactly .14 (one dim value everywhere)
      const others = page.locator(".terr:not(.lit)");
      expect(await others.count()).toBe(6 - footprint.length);
      for (const el of await others.all()) {
        await expect(el).toHaveCSS("opacity", "0.14");
      }
      // the hovered card itself stays hot while the rail dims
      expect(await hotTasks(page)).toEqual([taskId]);
    });
  }

  test("hover ends → focus fully resets (no dim, no lit, no hot)", async ({ page }) => {
    await open(page, "v8-baseline");
    await page.locator('[data-task="task-refactor-auth"]').hover();
    await expect(page.locator(".canvas")).toHaveClass(/focus/);
    await parkMouse(page);
    await expect(page.locator(".canvas")).not.toHaveClass(/focus/);
    await expect(page.locator(".rail")).not.toHaveClass(/dim/);
    expect(await litTerritories(page)).toEqual([]);
    expect(await hotTasks(page)).toEqual([]);
    await expect(page.locator(".terr").first()).toHaveCSS("opacity", "1");
  });
});

/* ── reverse correlate: territory → rail ───────────────────────────────── */

test.describe("reverse correlate (territory → rail, v8-baseline)", () => {
  test("hover Build & CI lights its writer + readers in the rail", async ({ page }) => {
    await open(page, "v8-baseline");
    await page.locator('[data-territory="t-ci"]').hover();
    await expect(page.locator(".rail")).toHaveClass(/dim/);
    // occupancy: writer e2e-smoke; readers migrate-sqlite + auto-retry
    expect(await hotTasks(page)).toEqual([
      "task-auto-retry-payments",
      "task-e2e-smoke",
      "task-migrate-sqlite",
    ]);
    expect(await litTerritories(page)).toEqual(["t-ci"]);
    await parkMouse(page);
    await expect(page.locator(".rail")).not.toHaveClass(/dim/);
  });

  test("hover a quiet territory (Web UI) lights its done-today task", async ({ page }) => {
    await open(page, "v8-baseline");
    await page.locator('[data-territory="t-fe"]').hover();
    // "touching" includes done-today (honesty: the map remembers the day)
    expect(await hotTasks(page)).toEqual(["task-reconnect-sse"]);
    expect(await litTerritories(page)).toEqual(["t-fe"]);
  });

  test("hover the conflicted territory lights both conflict parties", async ({ page }) => {
    await open(page, "v8-baseline");
    // hover near the top of t-pay to avoid landing on a sub-block
    await page
      .locator('[data-territory="t-pay"]')
      .hover({ position: { x: 200, y: 10 } });
    const hot = await hotTasks(page);
    expect(hot).toContain("task-auto-retry-payments");
    expect(hot).toContain("task-cancel-orders");
  });
});

/* ── legend filter: lights territory set AND rail cards ────────────────── */

// Hand-derived from highlightForLegend semantics over v8-baseline occupancy
// (reader-who-also-writes counts as writer only — t-pay is NOT "reading").
const LEGEND_EXPECT: Record<string, { terr: string[]; tasks: string[] }> = {
  w: {
    terr: ["t-auth", "t-ci", "t-pay", "t-store"],
    tasks: [
      "task-auto-retry-payments",
      "task-cancel-orders",
      "task-e2e-smoke",
      "task-migrate-sqlite",
      "task-refactor-auth",
    ],
  },
  r: {
    terr: ["t-ci", "t-notify", "t-store"],
    tasks: [
      "task-auto-retry-payments",
      "task-cancel-orders",
      "task-e2e-smoke",
      "task-migrate-sqlite",
      "task-refactor-auth",
    ],
  },
  clash: {
    terr: ["t-pay"],
    tasks: ["task-auto-retry-payments", "task-cancel-orders"],
  },
  quiet: { terr: ["t-fe"], tasks: [] },
};

test.describe("legend filter (v8-baseline)", () => {
  for (const [kind, expected] of Object.entries(LEGEND_EXPECT)) {
    test(`"${kind}" lights ${expected.terr.join("+")} and ${expected.tasks.length} rail card(s)`, async ({ page }) => {
      await open(page, "v8-baseline");
      await page.locator(`.legend span[data-kind="${kind}"]`).hover();
      await expect(page.locator(".canvas")).toHaveClass(/focus/);
      expect(await litTerritories(page)).toEqual(expected.terr);
      expect(await hotTasks(page)).toEqual(expected.tasks);
      await parkMouse(page);
      await expect(page.locator(".canvas")).not.toHaveClass(/focus/);
    });
  }
});

/* ── tooltip semantics ─────────────────────────────────────────────────── */

test.describe("tooltip", () => {
  test("260ms intent delay: nothing early, tooltip after; instant hide", async ({ page }) => {
    await open(page, "v8-baseline");
    const tip = page.locator("#tip");
    await page.locator('[data-task="task-refactor-auth"] .pill').hover();
    await page.waitForTimeout(80); // well inside the 260ms intent window
    await expect(tip).not.toHaveClass(/on/);
    await page.waitForTimeout(450); // 80+450 > 260 + show transition
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText("session-expiry policy");
    await parkMouse(page); // leaving hides (park target has its own no-tip zone)
    await expect(tip).not.toHaveClass(/on/);
  });

  test("flips above the anchor near the bottom edge (legend)", async ({ page }) => {
    await open(page, "v8-baseline");
    const anchor = page.locator('.legend span[data-kind="quiet"]');
    await anchor.hover();
    await page.waitForTimeout(500);
    const tip = page.locator("#tip");
    await expect(tip).toHaveClass(/on/);
    const tipBox = await tip.boundingBox();
    const anchorBox = await anchor.boundingBox();
    expect(tipBox && anchorBox && tipBox.y + tipBox.height <= anchorBox.y + 1).toBe(true);
  });

  test("abbreviated 100k surfaces the exact value in its tooltip", async ({ page }) => {
    await open(page, "scope-overload");
    await page
      .locator('[data-territory="x-core"]')
      .hover({ position: { x: 250, y: 120 } }); // mid-block: not label, not foot
    await page.waitForTimeout(500);
    const tip = page.locator("#tip");
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText("100k anchored files (100,000 exactly)");
  });
});

/* ── chip wrap (rev-1, Wayne verdict 2026-07-12) + pathological +N ─────── */
/* RULE REVISION: chips wrap and are ALL visible by default (the card grows
   taller); the single-line +N collapse survives only past 12 chips. These
   replace the former "+8 collapse" test. */

test("chip wrap: 9 scopes + branch = 10 visible chips, wrapped rows, no +N", async ({ page }) => {
  await open(page, "scope-overload");
  const card = page.locator('[data-task="task-nine-scopes"]');
  await expect(card.locator(".chip")).toHaveCount(10);
  await expect(card.locator(".chip.more")).toHaveCount(0);
  // the row actually wraps: taller than one 16px chip line
  const rowBox = await card.locator(".row2").boundingBox();
  expect(rowBox!.height).toBeGreaterThan(2 * 16);
  // every chip stays inside the card — visible, not clipped
  const cardBox = await card.boundingBox();
  for (const chip of await card.locator(".chip").all()) {
    const b = await chip.boundingBox();
    expect(b!.x).toBeGreaterThanOrEqual(cardBox!.x - 0.5);
    expect(b!.x + b!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
    expect(b!.y + b!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height + 0.5);
  }
  // branch chip shows the FULL branch (fits the 28-char budget untruncated)
  await expect(card.locator(".chip.n")).toHaveText("acme/unify-error-handling");
});

test("long branch name renders middle-truncated, exact branch in the tooltip", async ({ page }) => {
  await open(page, "scope-overload");
  const branchChip = page.locator('[data-task="task-long-title"] .chip.n');
  // middleTruncate("acme/fix-payments-gateway-502s", 28) — head+tail preserved
  await expect(branchChip).toHaveText("acme/fix-payme…-gateway-502s");
  await branchChip.hover();
  await page.waitForTimeout(500);
  const tip = page.locator("#tip");
  await expect(tip).toHaveClass(/on/);
  await expect(tip).toContainText("branch acme/fix-payments-gateway-502s");
});

test("pathological chip count (>12): wraps ~3 rows then +N; tooltip enumerates the rest", async ({ page }) => {
  await open(page, "scope-overload");
  const card = page.locator('[data-task="task-pathological-scopes"]');
  // 14 scopes + branch = 15 chips → first 11 + "+4"
  await expect(card.locator(".chip")).toHaveCount(12);
  const more = card.locator(".chip.more");
  await expect(more).toHaveText("+4");
  await more.hover();
  await page.waitForTimeout(500);
  const tip = page.locator("#tip");
  await expect(tip).toHaveClass(/on/);
  await expect(tip).toContainText("branch acme/audit-error-propagation-sweep");
  await expect(tip).toContainText(
    "reads Infra & Deploy, Vendored Monolith Compatibility Shims",
  );
});

/* ── fixture switcher + console health ─────────────────────────────────── */

const ALL_FIXTURES = [
  "v8-baseline",
  "empty-project",
  "scope-overload",
  "forty-territories",
];

test.describe("fixtures render clean", () => {
  for (const fixture of ALL_FIXTURES) {
    test(`${fixture}: renders with zero console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(String(err)));
      await open(page, fixture);
      await expect(page.locator(".window")).toBeVisible();
      await expect(page.locator(".titlebar")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("titlebar switcher swaps fixtures live", async ({ page }) => {
    await open(page, "v8-baseline");
    await expect(page.locator(".terr")).toHaveCount(6);
    await page.locator(".snapshot-switch").selectOption("forty-territories");
    await settle(page);
    await expect(page.locator(".terr")).toHaveCount(40);
    await page.locator(".snapshot-switch").selectOption("empty-project");
    await expect(page.locator(".terr")).toHaveCount(0);
    await expect(page.locator(".canvas-empty")).toBeVisible();
    await expect(page.locator(".rail-empty")).toBeVisible();
  });
});

/* ── five states present (forty-territories) ───────────────────────────── */

test("all five state pills render in forty-territories", async ({ page }) => {
  await open(page, "forty-territories");
  for (const pill of ["QUEUED", "RUNNING", "WAITING", "STALLED", "DONE"]) {
    await expect(
      page.locator(".pill", { hasText: pill }).first(),
      `pill ${pill}`,
    ).toBeVisible();
  }
  // grouping sanity at density: Needs you / Running / Queued / Done today
  await expect(page.locator(".group h4")).toHaveCount(4);
});

/* ── keyboard parity (correlate reachable without a mouse) ─────────────── */

test("keyboard focus on a rail card drives correlate like hover", async ({ page }) => {
  await open(page, "v8-baseline");
  await page.locator('[data-task="task-e2e-smoke"]').focus();
  await expect(page.locator(".canvas")).toHaveClass(/focus/);
  expect(await litTerritories(page)).toEqual(["t-ci"]);
  await page.locator('[data-task="task-e2e-smoke"]').blur();
  await expect(page.locator(".canvas")).not.toHaveClass(/focus/);
});

/* ── screen sizes: no overlap, no clipping ─────────────────────────────── */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Positive-area intersection with 1px tolerance (adjacent edges are fine). */
function overlaps(a: Box, b: Box): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 1 && h > 1;
}

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

test.describe("no overlap / no clipping", () => {
  for (const vp of VIEWPORTS) {
    for (const fixture of ["v8-baseline", "forty-territories"]) {
      test(`${fixture} @${vp.width}x${vp.height}: legend clears every territory; nothing clips`, async ({ page }) => {
        await page.setViewportSize(vp);
        await open(page, fixture);
        const legendBox = await page.locator(".legend").boundingBox();
        expect(legendBox).not.toBeNull();
        const canvasBox = await page.locator(".canvas").boundingBox();
        expect(canvasBox).not.toBeNull();
        const terrs = await page.locator(".terr").all();
        expect(terrs.length).toBe(fixture === "v8-baseline" ? 6 : 40);
        for (const terr of terrs) {
          const box = await terr.boundingBox();
          expect(box).not.toBeNull();
          // the known S4 bug: legend floated over the bottom row's feet
          expect(overlaps(legendBox!, box!), "legend must not cover a territory").toBe(false);
          // territory fully inside the canvas — no clipping at either size
          expect(box!.x + 0.5).toBeGreaterThanOrEqual(canvasBox!.x);
          expect(box!.y + 0.5).toBeGreaterThanOrEqual(canvasBox!.y);
          expect(box!.x + box!.width).toBeLessThanOrEqual(canvasBox!.x + canvasBox!.width + 0.5);
          expect(box!.y + box!.height).toBeLessThanOrEqual(canvasBox!.y + canvasBox!.height + 0.5);
        }
        // the app window itself fits the viewport
        const winBox = await page.locator(".window").boundingBox();
        expect(winBox!.x).toBeGreaterThanOrEqual(0);
        expect(winBox!.y).toBeGreaterThanOrEqual(0);
        expect(winBox!.x + winBox!.width).toBeLessThanOrEqual(vp.width);
        expect(winBox!.y + winBox!.height).toBeLessThanOrEqual(vp.height);
      });
    }
  }
});
