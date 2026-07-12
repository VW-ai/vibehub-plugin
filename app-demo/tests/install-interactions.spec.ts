/**
 * empty-install S5 interaction + state suite (LOOP.md mechanical gate for
 * stage exit).
 *
 * Covers: the CTA demo storyboard end-to-end via the CLICK path (the parity
 * spec owns the Enter path) with timing-tolerant assertions; the
 * failed→Retry→completes path; Map-this-repo → mapping status chip → stop,
 * in BOTH placements (Moment B guide + Moment C corner); footprint hover
 * tooltip semantics (260ms intent delay, exact count + sample files) and
 * keyboard parity (tabbable, Enter/Space opens); rail card + footprint click
 * → task panel (iter-17 debt) — synthetic panels rendered honestly (launch
 * row only, empty tail; see fixtures/synthetic-panel.ts) — with all three
 * close paths (X / Escape / scrim) returning focus to the exact opener; the
 * "+N earlier sessions" chip → listing popover (fork iter-18: a listing, NOT
 * re-packing — the sessions collapsed precisely because the floors no longer
 * fit), rows open their task's panel, Escape/outside-click/re-click yield the
 * space back; and geometry at 1280×800 + 1440×900 on the two extremes
 * (nine-footprints, tiny-repo): blocks inside the territory, pairwise no
 * overlap, cap honored, chip + popover in-bounds, no page overflow.
 *
 * Expected literals are hand-derived from src/fixtures/install-* — if a
 * fixture changes, these change with it.
 */
import { expect, test, type Page } from "@playwright/test";

const BASE = "http://localhost:5199";

/** Let entry animations finish (longest: winIn .5s). */
async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

async function open(page: Page, name: string) {
  await page.goto(`${BASE}/?install=${name}&switcher=0`);
  await settle(page);
}

/** Attach console/page error collection; returns the (live) error list. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

const HEALTH = "install-task-health";
const TRACING = "install-task-tracing";

/* ── the CTA demo storyboard, end-to-end (click path) ──────────────────── */

test("CTA click: connect → installing (steps advance) → connected chrome, zero errors", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page, "connect");
  await page.locator(".cta").click();
  // hard-swap to the installing fixture: picked path + mid-flight checklist
  await expect(page.locator(".path")).toBeVisible();
  await expect(page.locator(".cta")).toHaveCount(0);
  // steps advance in order (timing-tolerant: assert milestones, not ticks)
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(2, { timeout: 6000 });
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(3, { timeout: 6000 });
  // hold → exit → hard swap: connected chrome (Moment B), guidance present
  await expect(page.locator(".terr.quiet")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".connect")).toHaveCount(0);
  await expect(page.locator(".repo")).toContainText("acme/greenfield");
  await expect(page.locator(".fresh")).toHaveText(/Synced just now/);
  await expect(page.locator(".group.zero")).toHaveCount(3);
  await expect(page.locator(".launch")).toBeVisible();
  await expect(page.locator(".guide p")).toBeVisible();
  expect(page.url()).toContain("install=connected");
  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("Retry path: ONLY the failed step reruns, then the storyboard completes", async ({
  page,
}) => {
  await open(page, "install-failed");
  // the honest partial-success card: 2 done + 1 failed with the reason row
  await expect(page.locator('.step[data-status="failed"]')).toHaveCount(1);
  await page.locator(".retry").click();
  // the failed step reruns alone — the two done steps never regress
  await expect(page.locator('.step[data-status="now"] .busy')).toBeVisible();
  await expect(page.locator('.step[data-status="done"]')).toHaveCount(2);
  await expect(page.locator(".why")).toHaveCount(0);
  await expect(page.locator('.step[data-status="failed"]')).toHaveCount(0);
  // …and completes into the connected swap
  await expect(page.locator(".terr.quiet")).toBeVisible({ timeout: 6000 });
  await expect(page.locator(".connect")).toHaveCount(0);
});

/* ── Map this repo → mapping chip → stop (both placements) ─────────────── */

test.describe("Map this repo", () => {
  test("Moment B guide: button yields to the honest chip; chip click stops", async ({
    page,
  }) => {
    await open(page, "connected");
    await page.locator(".guide .mapbtn").click();
    const chip = page.locator(".guide .mapstat");
    await expect(chip).toContainText("Mapping this repo");
    // elapsed mono time, never a percent (no honest fraction exists)
    await expect(chip.locator(".t")).toBeVisible();
    await expect(chip).not.toContainText("%");
    await chip.click(); // tooltip promise: click stops the pass
    await expect(page.locator(".guide .mapbtn")).toBeVisible();
    await expect(page.locator(".mapstat")).toHaveCount(0);
  });

  test("Moment C corner: same yield/stop cycle; footprint untouched", async ({ page }) => {
    await open(page, "first-task");
    await page.locator(".mapbtn.corner").click();
    const chip = page.locator(".mapstat.corner");
    await expect(chip).toContainText("Mapping this repo");
    await expect(page.locator(".fp")).toHaveCount(1); // nothing else moved
    await chip.click();
    await expect(page.locator(".mapbtn.corner")).toBeVisible();
    await expect(page.locator(".fp")).toHaveCount(1);
  });
});

/* ── footprint tooltip: 260ms intent delay + exact count + samples ─────── */

test("footprint tooltip honors the 260ms intent delay, then names count + files", async ({
  page,
}) => {
  await open(page, "first-task");
  const tip = page.locator("#tip");
  await page.locator(".fp").hover();
  await page.waitForTimeout(80); // well inside the 260ms intent window
  await expect(tip).not.toHaveClass(/on/);
  await page.waitForTimeout(450); // 80+450 > 260 + show transition
  await expect(tip).toHaveClass(/on/);
  // exact count + the sampled paths + the honest promise
  await expect(tip).toContainText("'Add health-check endpoint' has edited 3 files");
  await expect(tip).toContainText("src/health/endpoint.ts");
  await expect(tip).toContainText("once the repo is mapped");
  // instant hide on leave
  await page.mouse.move(40, 20);
  await expect(tip).not.toHaveClass(/on/);
});

/* ── rail card + footprint open the task panel (iter-17 debt) ──────────── */

test.describe("task panel on the first-run screen", () => {
  test("rail card click opens an HONEST synthetic panel (launch row only)", async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await open(page, "first-task");
    await page.locator(`[data-task="${HEALTH}"]`).click();
    const panel = page.locator(".panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("role", "dialog");
    await expect(panel).toHaveAttribute("aria-label", "Task: Add health-check endpoint");
    await expect(panel.locator(".pill").first()).toHaveText("RUNNING");
    // synthetic honesty: exactly ONE timeline row (the launch; the title
    // stands in for the prompt — logged stand-in, DECISIONS iter-7).
    await expect(panel.locator(".tl .ev")).toHaveCount(1);
    await expect(panel.locator(".tl .ev .who")).toContainText("You · launched");
    // …and the tail admits it holds nothing
    await page.locator(".actions .quiet", { hasText: "View transcript" }).click();
    await expect(panel.locator(".tail")).toContainText("nothing emitted yet");
    // the canvas underneath is veiled while the panel is up (map parity)
    await expect(page.locator(".canvas.veiled")).toBeVisible();
    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  test("keyboard parity: Enter on a focused card opens; Escape returns focus", async ({
    page,
  }) => {
    await open(page, "first-task");
    await page.locator(`[data-task="${HEALTH}"]`).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".panel")).toHaveCount(0);
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset?.task ?? null,
    );
    expect(focused).toBe(HEALTH);
    await expect(page.locator(".canvas.veiled")).toHaveCount(0); // veil yields back
  });

  test("footprint is tabbable; Enter opens ITS task's panel; X returns focus", async ({
    page,
  }) => {
    await open(page, "two-tasks");
    const fp = page.locator(`[data-fp="${TRACING}"]`);
    await expect(fp).toHaveAttribute("tabindex", "0");
    await expect(fp).toHaveAttribute("role", "button");
    await fp.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator(".panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute(
      "aria-label",
      "Task: Wire request tracing through services",
    );
    await panel.locator(".pclose").click();
    await expect(panel).toHaveCount(0);
    // focus lands after the unmount paints (rAF) — poll, don't race it
    await expect
      .poll(() =>
        page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset?.fp ?? null,
        ),
      )
      .toBe(TRACING);
  });

  test("footprint click + scrim close; switching panels remounts per task", async ({
    page,
  }) => {
    await open(page, "two-tasks");
    await page.locator(`[data-fp="${HEALTH}"]`).click();
    await expect(page.locator(".panel h2")).toHaveText("Add health-check endpoint");
    // scrim closes (click outside the 520px panel)
    await page.locator(".scrim").click({ position: { x: 40, y: 400 } });
    await expect(page.locator(".panel")).toHaveCount(0);
    // the OTHER task via its rail card — fresh panel, fresh identity
    await page.locator(`[data-task="${TRACING}"]`).click();
    await expect(page.locator(".panel h2")).toHaveText(
      "Wire request tracing through services",
    );
    await expect(page.locator(".panel .tl .ev")).toHaveCount(1);
  });
});

/* ── the "+N earlier sessions" chip → listing popover (fork iter-18) ───── */

test.describe("+N earlier sessions popover", () => {
  test("chip click lists the 3 collapsed sessions, oldest first, exact counts", async ({
    page,
  }) => {
    await open(page, "nine-footprints");
    const chip = page.locator(".fp-chip");
    await expect(chip).toHaveText("+3 earlier sessions");
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    const rows = page.locator(".fp-pop .row");
    await expect(rows).toHaveCount(3);
    // collapse order = packing order (oldest first) — fixture tasks 0..2
    await expect(rows.nth(0).locator(".t")).toHaveText("Fix flaky retry test");
    await expect(rows.nth(1).locator(".t")).toHaveText("Add rate-limit headers");
    await expect(rows.nth(2).locator(".t")).toHaveText("Bump node to 22");
    // text = first channel: each row carries its exact file count
    await expect(rows.nth(0).locator(".n")).toHaveText("2 files");
    // the 6 visible blocks did NOT re-pack — a listing, not a re-layout
    await expect(page.locator(".fp")).toHaveCount(6);
  });

  test("popover row opens that task's panel; close returns focus to the chip", async ({
    page,
  }) => {
    await open(page, "nine-footprints");
    await page.locator(".fp-chip").click();
    await page.locator(".fp-pop .row", { hasText: "Fix flaky retry test" }).click();
    const panel = page.locator(".panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("aria-label", "Task: Fix flaky retry test");
    await expect(panel.locator(".tl .ev")).toHaveCount(1); // synthetic honesty
    // the popover yielded its space when the panel took over
    await expect(page.locator(".fp-pop")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    // focus lands on the chip (the popover row is gone — chip is the opener);
    // after the unmount paints (rAF) — poll, don't race it
    await expect
      .poll(() =>
        page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.className ?? "",
        ),
      )
      .toContain("fp-chip");
  });

  test("popover yields: Escape (focus→chip), outside click, chip re-click", async ({
    page,
  }) => {
    await open(page, "nine-footprints");
    const chip = page.locator(".fp-chip");
    // Escape
    await chip.click();
    await expect(page.locator(".fp-pop")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".fp-pop")).toHaveCount(0);
    await expect(chip).toBeFocused();
    // outside click (the territory gray)
    await chip.click();
    await expect(page.locator(".fp-pop")).toBeVisible();
    await page.locator(".terr.quiet").click({ position: { x: 30, y: 30 } });
    await expect(page.locator(".fp-pop")).toHaveCount(0);
    // chip re-click toggles
    await chip.click();
    await expect(page.locator(".fp-pop")).toBeVisible();
    await chip.click();
    await expect(page.locator(".fp-pop")).toHaveCount(0);
    await expect(chip).toHaveAttribute("aria-expanded", "false");
  });
});

/* ── correlate-hover: card ↔ footprint (dim .14 + ring + scale) ────────── */

/** Computed opacity of a locator (polled by callers — transitions are 200ms). */
async function opacity(page: Page, selector: string): Promise<number> {
  return page.$eval(selector, (el) => Number(getComputedStyle(el).opacity));
}

test.describe("correlate-hover", () => {
  test("card hover/focus lights its footprint; the other dims to .14; yields back", async ({
    page,
  }) => {
    await open(page, "two-tasks");
    await page.locator(`[data-task="${HEALTH}"]`).hover();
    await expect(page.locator(`[data-fp="${HEALTH}"]`)).toHaveClass(/lit/);
    await expect.poll(() => opacity(page, `[data-fp="${TRACING}"]`)).toBeCloseTo(0.14, 2);
    await expect.poll(() => opacity(page, `[data-fp="${HEALTH}"]`)).toBe(1);
    // space yields back on leave
    await page.mouse.move(40, 20);
    await expect(page.locator(".terr.fpfocus")).toHaveCount(0);
    await expect.poll(() => opacity(page, `[data-fp="${TRACING}"]`)).toBe(1);
    // keyboard parity: FOCUS is a correlate source too
    await page.locator(`[data-task="${TRACING}"]`).focus();
    await expect(page.locator(`[data-fp="${TRACING}"]`)).toHaveClass(/lit/);
  });

  test("footprint hover dims the rail; its card stays hot at full opacity", async ({
    page,
  }) => {
    await open(page, "two-tasks");
    await page.locator(`[data-fp="${TRACING}"]`).hover();
    await expect(page.locator(".rail.dim")).toBeVisible();
    await expect(page.locator(`[data-task="${TRACING}"]`)).toHaveClass(/hot/);
    await expect.poll(() => opacity(page, `[data-task="${TRACING}"]`)).toBe(1);
    await expect.poll(() => opacity(page, `[data-task="${HEALTH}"]`)).toBeCloseTo(0.3, 2);
    // the hovered footprint itself is the lit subject
    await expect(page.locator(`[data-fp="${TRACING}"]`)).toHaveClass(/lit/);
  });

  test("a COLLAPSED task's card lights the +N chip (its block has no pixels)", async ({
    page,
  }) => {
    await open(page, "nine-footprints");
    // install-task-nine-0 is one of the 3 oldest → collapsed into the chip
    await page.locator('[data-task="install-task-nine-0"]').hover();
    await expect(page.locator(".fp-chip")).toHaveClass(/hot/);
    await expect.poll(() => opacity(page, ".fp-chip")).toBe(1);
    // every visible block dims — none of them is the subject
    await expect.poll(() => opacity(page, '[data-fp="install-task-nine-3"]')).toBeCloseTo(
      0.14,
      2,
    );
    await expect(page.locator(".fp.lit")).toHaveCount(0);
  });
});

/* ── geometry on the extremes, both viewports ──────────────────────────── */

type Box = { x: number; y: number; width: number; height: number };

function inside(b: Box, outer: Box, tol = 1): void {
  expect(b.x).toBeGreaterThanOrEqual(outer.x - tol);
  expect(b.y).toBeGreaterThanOrEqual(outer.y - tol);
  expect(b.x + b.width).toBeLessThanOrEqual(outer.x + outer.width + tol);
  expect(b.y + b.height).toBeLessThanOrEqual(outer.y + outer.height + tol);
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

for (const vp of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const) {
  test(`nine-footprints geometry @${vp.width}x${vp.height}: in-bounds, no overlap, popover in-bounds`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await open(page, "nine-footprints");
    const terr = await page.locator(".terr.quiet").boundingBox();
    expect(terr).toBeTruthy();
    if (!terr) return;
    const fps = page.locator(".fp");
    await expect(fps).toHaveCount(6);
    const boxes: Box[] = [];
    for (let i = 0; i < 6; i++) {
      const b = await fps.nth(i).boundingBox();
      expect(b, `fp ${i}`).toBeTruthy();
      if (!b) return;
      inside(b, terr);
      boxes.push(b);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i]!, boxes[j]!), `fp ${i} vs ${j}`).toBe(false);
      }
    }
    // chip pinned inside the gray; popover opens fully inside the viewport
    const chip = await page.locator(".fp-chip").boundingBox();
    expect(chip).toBeTruthy();
    if (chip) inside(chip, terr);
    await page.locator(".fp-chip").click();
    const pop = await page.locator(".fp-pop").boundingBox();
    expect(pop).toBeTruthy();
    if (pop) inside(pop, terr);
    // no page overflow in either axis
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(overflow).toEqual({ x: false, y: false });
  });

  test(`tiny-repo geometry @${vp.width}x${vp.height}: cap honored, in-bounds, no overlap`, async ({
    page,
  }) => {
    await page.setViewportSize(vp);
    await open(page, "tiny-repo");
    const terr = await page.locator(".terr.quiet").boundingBox();
    const sweep = await page.locator('[data-fp="install-task-tiny-sweep"]').boundingBox();
    const readme = await page.locator('[data-fp="install-task-tiny-readme"]').boundingBox();
    expect(terr && sweep && readme).toBeTruthy();
    if (!terr || !sweep || !readme) return;
    inside(sweep, terr);
    inside(readme, terr);
    expect(overlaps(sweep, readme)).toBe(false);
    // the 10/12 block clamps to the 60% area CAP — the gray must visibly
    // remain "the whole repo" (allow shrink below via the overflow ladder)
    const capArea = (sweep.width * sweep.height) / (terr.width * terr.height);
    expect(capArea).toBeLessThanOrEqual(0.6 + 0.01);
    // both feet stay legible (visible, non-mono foot text)
    await expect(
      page.locator('[data-fp="install-task-tiny-sweep"] .files'),
    ).toBeVisible();
    await expect(
      page.locator('[data-fp="install-task-tiny-readme"] .files'),
    ).toHaveText("1 file · not yet mapped to features");
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    expect(overflow).toEqual({ x: false, y: false });
  });
}
