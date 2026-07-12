import { BASE } from "./env";
/**
 * task-panel S5 interaction + state suite (LOOP.md mechanical gate for
 * stage exit).
 *
 * Covers: open paths (card click / Enter / Space), close paths (X, Escape,
 * scrim click) with focus returning to the opening card (keyboard parity —
 * recorded principle), open-at-newest + scroll-aware tlbar seam shadow,
 * the DERIVED Milestones tier (auth timeline 10 → 3 → 10), file_change
 * expand/collapse with off-scope files in clash ink, transcript tail toggle
 * with pressed state, textarea autogrow to the 124px cap with internal
 * scroll (deck stays pinned), mode toggle narration, tooltip semantics on
 * panel anchors (260ms intent delay + real content), synthetic-panel
 * honesty (queued → empty timeline; running → launch row only, nothing
 * fabricated), the ?panel=marathon extreme (60 rows, session 12 of 12,
 * deck pinned), and overlap/clipping checks with the panel open at
 * 1280×800 + 1440×900.
 *
 * Expected literals are hand-derived from src/fixtures/panel-* — if a
 * fixture changes, these change with it (the derivation rules in
 * panel-derive.ts are product rules now).
 */
import { expect, test, type Page } from "@playwright/test";


/** Let map entry animations finish (longest: territory .34s delay + .55s). */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

const AUTH_CARD = '[data-task="task-refactor-auth"]';

/** The real integration path: v8-baseline, click the waiting card. */
async function openAuthPanel(page: Page) {
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
  await settle(page);
  await page.locator(AUTH_CARD).click();
  await expect(page.locator(".panel")).toBeVisible();
  await page.waitForTimeout(400); // slide-in 200ms + settle
}

/** data-task of the currently focused element (null if none). */
async function focusedTask(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset?.task ?? null,
  );
}

/* ── open paths: click / Enter / Space ─────────────────────────────────── */

test.describe("open paths", () => {
  test("card click opens the panel as a labeled dialog", async ({ page }) => {
    await openAuthPanel(page);
    const panel = page.locator(".panel");
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-label", "Task: Refactor auth flow");
    // identity row carries the S2 content, from the fixture
    await expect(panel.locator(".pill").first()).toHaveText("WAITING");
    await expect(panel.locator("h2")).toHaveText("Refactor auth flow");
  });

  test("Enter on a focused card opens the panel (keyboard parity)", async ({ page }) => {
    await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
    await settle(page);
    await page.locator(AUTH_CARD).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeVisible();
  });

  test("Space on a focused card opens the panel (keyboard parity)", async ({ page }) => {
    await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0`);
    await settle(page);
    await page.locator(AUTH_CARD).focus();
    await page.keyboard.press("Space");
    await expect(page.locator(".panel")).toBeVisible();
  });
});

/* ── close paths: X / Escape / scrim — focus returns to the card ───────── */

test.describe("close paths (focus returns to the opening card)", () => {
  test("X closes; focus returns to the opening card", async ({ page }) => {
    await openAuthPanel(page);
    await page.locator(".pclose").click();
    await expect(page.locator(".panel")).toHaveCount(0);
    await expect(page.locator(".scrim")).toHaveCount(0);
    await expect.poll(() => focusedTask(page)).toBe("task-refactor-auth");
  });

  test("Escape closes; focus returns to the opening card", async ({ page }) => {
    await openAuthPanel(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".panel")).toHaveCount(0);
    await expect.poll(() => focusedTask(page)).toBe("task-refactor-auth");
  });

  test("scrim click closes; focus returns to the opening card", async ({ page }) => {
    await openAuthPanel(page);
    // click well left of the panel (the scrim spans the whole .main)
    await page.locator(".scrim").click({ position: { x: 60, y: 300 } });
    await expect(page.locator(".panel")).toHaveCount(0);
    await expect.poll(() => focusedTask(page)).toBe("task-refactor-auth");
  });
});

/* ── open-at-newest + scroll-aware seam shadow ─────────────────────────── */

test("opens scrolled to the newest event; seam shadow tracks scroll", async ({ page }) => {
  await openAuthPanel(page);
  const tl = page.locator(".tl");
  // at 1280×800 the auth timeline overflows → opens at the bottom (newest)
  const atOpen = await tl.evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
  expect(atOpen.max).toBeGreaterThan(0);
  expect(atOpen.top).toBeGreaterThanOrEqual(atOpen.max - 1);
  await expect(page.locator(".tlbar")).toHaveClass(/scrolled/);
  // scroll to the top → the shadow clears (nothing is hidden above)
  await tl.evaluate((el) => (el.scrollTop = 0));
  await expect(page.locator(".tlbar")).not.toHaveClass(/scrolled/);
  // and returns when history is above the fold again
  await tl.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator(".tlbar")).toHaveClass(/scrolled/);
});

/* ── Milestones toggle: the DERIVED 023 tier ───────────────────────────── */

test("Milestones tier: auth timeline 10 → 3 derived entries, and back", async ({ page }) => {
  await openAuthPanel(page);
  const rows = page.locator(".tl .ev");
  await expect(rows).toHaveCount(10);
  await page.locator(".seg button", { hasText: "Milestones" }).click();
  await expect(page.locator(".seg button", { hasText: "Milestones" })).toHaveClass(/on/);
  // derived tier (isMilestone, 023 whitelist): launch · injection · question
  await expect(rows).toHaveCount(3);
  await expect(page.locator(".tl .ev.user")).toHaveCount(2); // launch + injection
  await expect(page.locator(".tl .ev.ask")).toHaveCount(1); // the waiting cause
  await expect(rows.first()).toContainText("You · launched");
  await expect(rows.last()).toContainText("Stopped to ask you:");
  // back to All → the full history returns, order preserved
  await page.locator(".seg button", { hasText: "All" }).click();
  await expect(rows).toHaveCount(10);
});

/* ── file_change expand/collapse + off-scope clash ink ─────────────────── */

test("files burst expands/collapses; off-scope files carry clash ink", async ({ page }) => {
  await openAuthPanel(page);
  const burst = page.locator(".tl .ev", { has: page.locator(".filestoggle") });
  await expect(burst).toHaveCount(1);
  await expect(burst.locator(".files")).toBeHidden();
  await burst.locator(".filestoggle").click();
  await expect(burst).toHaveClass(/open/);
  await expect(burst.locator(".files")).toBeVisible();
  // in-scope files listed; the two off-scope files flagged, amber (clash ink)
  await expect(burst.locator(".files")).toContainText("src/auth/session-store.ts");
  const out = burst.locator(".files .out");
  await expect(out).toContainText("cron/cleanup.ts · config/redis.ts");
  await expect(out).toContainText("outside declared scope");
  const colors = await out.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--clash-ink)";
    document.body.appendChild(probe);
    const clash = getComputedStyle(probe).color;
    probe.remove();
    return {
      out: getComputedStyle(el).color,
      base: getComputedStyle(el.parentElement!).color,
      clash,
    };
  });
  expect(colors.out).toBe(colors.clash); // exactly the clash token
  expect(colors.out).not.toBe(colors.base); // and visibly distinct
  // collapse: the list yields its space back
  await burst.locator(".filestoggle").click();
  await expect(burst).not.toHaveClass(/open/);
  await expect(burst.locator(".files")).toBeHidden();
});

/* ── transcript tail toggle + pressed state ────────────────────────────── */

test("View transcript toggles the tail; button carries a pressed state", async ({ page }) => {
  await openAuthPanel(page);
  const btn = page.locator(".actions .quiet", { hasText: "View transcript" });
  const tail = page.locator(".tail");
  await expect(tail).toBeHidden();
  await expect(btn).not.toHaveClass(/on/);
  await btn.click();
  await expect(tail).toBeVisible();
  await expect(tail).toContainText("[transcript tail · read-only]");
  await expect(btn).toHaveClass(/on/);
  await btn.click();
  await expect(tail).toBeHidden();
  await expect(btn).not.toHaveClass(/on/);
});

/* ── textarea autogrow: 52 → 124 cap, internal scroll, deck pinned ─────── */

test("textarea autogrows to the 124px cap then scrolls; deck stays pinned", async ({ page }) => {
  await openAuthPanel(page);
  const box = page.locator(".deck textarea");
  expect(await box.evaluate((el) => el.offsetHeight)).toBe(52); // floor
  await box.fill(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));
  const grown = await box.evaluate((el) => ({
    offset: el.offsetHeight,
    scroll: el.scrollHeight,
  }));
  expect(grown.offset).toBe(124); // the cap, exactly
  expect(grown.scroll).toBeGreaterThan(124); // overflow scrolls internally
  // the deck can never leave the viewport: bottom == panel bottom
  const deckBox = await page.locator(".deck").boundingBox();
  const panelBox = await page.locator(".panel").boundingBox();
  expect(Math.abs(deckBox!.y + deckBox!.height - (panelBox!.y + panelBox!.height))).toBeLessThanOrEqual(1);
  // shrinking gives the space back to the timeline
  await box.fill("");
  expect(await box.evaluate((el) => el.offsetHeight)).toBe(52);
});

/* ── mode toggle narrates its contract via the placeholder ─────────────── */

test("mode toggle switches the placeholder narration", async ({ page }) => {
  await openAuthPanel(page);
  const box = page.locator(".deck textarea");
  const inject = page.locator(".modes button", { hasText: "Inject without interrupting" });
  const pause = page.locator(".modes button", { hasText: "Pause & think together" });
  await expect(inject).toHaveClass(/on/);
  // waiting task + inject mode: delivery is immediate (the agent is parked)
  await expect(box).toHaveAttribute(
    "placeholder",
    "Answer its question, or give a new instruction — it is parked, so this lands immediately…",
  );
  await pause.click();
  await expect(pause).toHaveClass(/on/);
  await expect(inject).not.toHaveClass(/on/);
  await expect(box).toHaveAttribute(
    "placeholder",
    "It will stop first, then take your thoughts one by one — until you press Resume…",
  );
  await inject.click();
  await expect(inject).toHaveClass(/on/);
});

/* ── tooltips on panel anchors: 260ms intent delay + real content ──────── */

test.describe("panel tooltips", () => {
  test("age anchor honors the 260ms intent delay, then explains the state", async ({ page }) => {
    await openAuthPanel(page);
    const tip = page.locator("#tip");
    await page.locator(".panel .age").hover();
    await page.waitForTimeout(80); // well inside the intent window
    await expect(tip).not.toHaveClass(/on/);
    await page.waitForTimeout(450); // 80+450 > 260 + show transition
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText("In WAITING since 10:31");
  });

  test("deck anchors carry real contracts, not lorem", async ({ page }) => {
    await openAuthPanel(page);
    const tip = page.locator("#tip");
    await page.locator(".actions .term").hover();
    await page.waitForTimeout(500);
    await expect(tip).toHaveClass(/on/);
    await expect(tip).toContainText("The branch and worktree stay on disk");
    await page.locator(".seg button", { hasText: "Milestones" }).hover();
    await page.waitForTimeout(500);
    await expect(tip).toContainText("Milestones only");
    await expect(tip).toContainText("launch prompt");
  });
});

/* ── synthetic panels: honesty rules ───────────────────────────────────── */

test.describe("synthetic panels (no hand-authored fixture)", () => {
  test("queued task → honest empty timeline, nothing fabricated", async ({ page }) => {
    await page.goto(`${BASE}/?fixture=forty-territories&switcher=0`);
    await settle(page);
    await page.locator('[data-task="g-task-queued"]').click();
    const panel = page.locator(".panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".pill").first()).toHaveText("QUEUED");
    // no session has started: zero timeline rows, an honest note instead
    await expect(panel.locator(".tl .ev")).toHaveCount(0);
    await expect(panel.locator(".tl-empty")).toBeVisible();
    await expect(panel.locator(".tl-empty")).toContainText("Not launched yet");
    // and the transcript tail admits it holds nothing
    await page.locator(".actions .quiet", { hasText: "View transcript" }).click();
    await expect(panel.locator(".tail")).toContainText("nothing emitted yet");
  });

  test("running task → launch row only; no invented reports/commits/transitions", async ({ page }) => {
    await page.goto(`${BASE}/?fixture=forty-territories&switcher=0`);
    await settle(page);
    await page.locator('[data-task="g-task-running"]').click();
    const panel = page.locator(".panel");
    await expect(panel).toBeVisible();
    await expect(panel.locator(".pill").first()).toHaveText("RUNNING");
    // exactly one row: the launch (title stands in for the prompt — logged
    // stand-in, DECISIONS iter-7). No transition row for a running task.
    await expect(panel.locator(".tl .ev")).toHaveCount(1);
    await expect(panel.locator(".tl .ev.user")).toHaveCount(1);
    await expect(panel.locator(".tl .ev").first()).toContainText("You · launched");
    await expect(panel.locator(".tl .ev").first()).toContainText(
      "Backfill usage metering events",
    );
    await expect(panel.locator(".tl-empty")).toHaveCount(0);
  });
});

/* ── ?panel=marathon: N=many extreme ───────────────────────────────────── */

test("marathon: 60 rows scroll, deck pinned, session 12 of 12, zero errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${BASE}/?fixture=v8-baseline&switcher=0&panel=marathon`);
  await settle(page);
  const panel = page.locator(".panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".tl .ev")).toHaveCount(60);
  await expect(panel.locator(".meta")).toContainText("session 12 of 12");
  // the scroll region carries the load; the deck never moves
  const tl = page.locator(".tl");
  const range = await tl.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(range).toBeGreaterThan(500); // genuinely long history
  await tl.evaluate((el) => (el.scrollTop = 0));
  await expect(page.locator(".tlbar")).not.toHaveClass(/scrolled/);
  await tl.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator(".tlbar")).toHaveClass(/scrolled/);
  const deckBox = await page.locator(".deck").boundingBox();
  const panelBox = await panel.boundingBox();
  expect(Math.abs(deckBox!.y + deckBox!.height - (panelBox!.y + panelBox!.height))).toBeLessThanOrEqual(1);
  // Milestones tier holds at N=many (hand-derived: 14 of 60)
  await page.locator(".seg button", { hasText: "Milestones" }).click();
  await expect(panel.locator(".tl .ev")).toHaveCount(14);
  expect(errors).toEqual([]);
});

/* ── screen sizes: no overlap, no clipping with the panel open ─────────── */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const inside = (a: Box, b: Box, tol = 1) =>
  a.x >= b.x - tol &&
  a.y >= b.y - tol &&
  a.x + a.width <= b.x + b.width + tol &&
  a.y + a.height <= b.y + b.height + tol;

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

test.describe("panel geometry (no overlap / no clipping)", () => {
  for (const vp of VIEWPORTS) {
    test(`sections stack cleanly, actions fit @${vp.width}x${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await openAuthPanel(page);
      // busiest state: files burst expanded + transcript tail open
      await page.locator(".filestoggle").click();
      await page.locator(".actions .quiet", { hasText: "View transcript" }).click();
      await page.waitForTimeout(300);
      const panel = (await page.locator(".panel").boundingBox())!;
      const win = (await page.locator(".window").boundingBox())!;
      expect(inside(panel, win)).toBe(true); // panel never leaves the window
      // vertical stack: identity / tlbar / timeline / tail / deck — in order,
      // no section overlapping the next (positive-area intersection = defect)
      const sections = [".phead", ".tlbar", ".tl", ".tail", ".deck"];
      let prevBottom = panel.y - 1;
      for (const sel of sections) {
        const box = (await page.locator(sel).boundingBox())!;
        expect(box, sel).not.toBeNull();
        expect(box.y, `${sel} must start below the previous section`).toBeGreaterThanOrEqual(prevBottom - 1);
        expect(inside(box, panel, 2), `${sel} inside the panel`).toBe(true);
        prevBottom = box.y + box.height;
      }
      // deck pinned to the panel's bottom edge (padding is part of .deck)
      const deck = (await page.locator(".deck").boundingBox())!;
      expect(Math.abs(deck.y + deck.height - (panel.y + panel.height))).toBeLessThanOrEqual(1);
      // the action row fits: every button fully inside the panel, and
      // Terminate stays isolated from the main cluster (S2 rule: gap > 24px)
      for (const btn of await page.locator(".actions button").all()) {
        const b = (await btn.boundingBox())!;
        expect(inside(b, panel)).toBe(true);
      }
      const done = (await page.locator(".actions .quiet", { hasText: "Mark done" }).boundingBox())!;
      const term = (await page.locator(".actions .term").boundingBox())!;
      expect(term.x - (done.x + done.width)).toBeGreaterThan(24);
    });
  }
});
