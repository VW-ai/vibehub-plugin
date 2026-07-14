import { BASE } from "./env";
/**
 * conflict-card S5 — the interaction/state suite (LOOP.md S5 gate).
 *
 * Formalizes what S4 covered ad-hoc, plus the S5 additions:
 *   1. every conflict fixture × every zone state renders (matrix, one
 *      expectation row per fixture — zone a grade/symbols, zone b
 *      done/empty/fresh/stale, zone c placeholder/menu/noop);
 *   2. adjudication actions produce their preview feedback states
 *      (optimistic UI: SENT / REQUESTED / IGNORED band with the honest
 *      "preview — no live session" disclosure), keyboard-reachable;
 *   3. ignore-pair goes through one modest INLINE confirm (permanence
 *      gate — never a browser dialog); Escape priority: pause menu →
 *      ignore confirm → card;
 *   4. Run/Re-run diagnosis stub: toggles an honest inline note (no fake
 *      progress, no invented verdict);
 *   5. 1200-symbol scroll perf sanity;
 *   6. geometry at both viewports in the busiest states.
 */
import { expect, test, type Page } from "@playwright/test";

const APP = `${BASE}/?fixture=v8-baseline&switcher=0`;

async function settle(page: Page) {
  await page.waitForTimeout(1200);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
}

async function openViaParam(page: Page, name: string) {
  await page.goto(`${APP}&conflict=${name}`);
  await settle(page);
  await expect(page.locator(".modal")).toBeVisible();
}

/** Open the red card the REAL way (rail CONFLICT pill) — the only path with
 *  a live opener element for focus-return assertions. */
async function openRedViaPill(page: Page) {
  await page.goto(APP);
  await settle(page);
  await page.locator('[data-task="task-auto-retry-payments"] .pill').click();
  await expect(page.locator(".modal")).toBeVisible();
}

/* ── 1. fixture × zone-state matrix ───────────────────────────────────── */

interface Expectation {
  grade: "red" | "yellow";
  kicker: string;
  /** rows shown collapsed. */
  symsShown: number;
  /** collapsed "+N more" label, or null when the list fits. */
  toggle: string | null;
  /** h4 count text (NUMBER-huge rule). */
  count: string;
  diag: "fresh" | "stale" | "empty";
  /** the "· N edits since" marker, when stale with a known count. */
  edits?: string;
  placeholder: RegExp;
  noops: number;
}

const MATRIX: Record<string, Expectation> = {
  "osm-red-diagnosed": {
    grade: "red",
    kicker: "W × W",
    symsShown: 3,
    toggle: null,
    count: "3",
    diag: "fresh",
    placeholder: /leave empty to send the Suggested line/,
    noops: 0,
  },
  "no-diagnosis": {
    grade: "red",
    kicker: "W × W",
    symsShown: 3,
    toggle: null,
    count: "3",
    diag: "empty",
    placeholder: /one message, queued to both tasks/,
    noops: 0,
  },
  "yellow-stale": {
    grade: "yellow",
    kicker: "W × R",
    symsShown: 3,
    toggle: "+9 more",
    count: "12",
    diag: "stale",
    edits: "· 3 edits since",
    placeholder: /leave empty to send the Suggested line/,
    noops: 1,
  },
  "1200-symbols": {
    grade: "red",
    kicker: "W × W",
    symsShown: 3,
    toggle: "+1,197 more",
    count: "1.2k",
    diag: "stale",
    placeholder: /leave empty to send the Suggested line/,
    noops: 0,
  },
  "one-symbol": {
    grade: "red",
    kicker: "W × W",
    symsShown: 1,
    toggle: null,
    count: "1",
    diag: "empty",
    placeholder: /one message, queued to both tasks/,
    noops: 0,
  },
};

test("every fixture renders every zone in its expected state, zero errors", async ({ page }) => {
  const errors = collectErrors(page);
  for (const [name, x] of Object.entries(MATRIX)) {
    await openViaParam(page, name);

    // zone a: grading strip — text kicker first, class = color reinforcement
    await expect(page.locator(`.grade.${x.grade}`), name).toHaveCount(1);
    await expect(page.locator(".grade b"), name).toHaveText(x.kicker);
    // zone a: the pair — always exactly two side rows, each with a REAL
    // state pill and a branch chip (conflict stays an attribute)
    await expect(page.locator(".side"), name).toHaveCount(2);
    await expect(page.locator(".side .pill"), name).toHaveCount(2);
    // zone a: shared symbols — collapsed rows + toggle contract + count
    await expect(page.locator(".sym"), name).toHaveCount(x.symsShown);
    await expect(page.locator(".cbody h4 .mono").first(), name).toHaveText(x.count);
    if (x.toggle === null) {
      await expect(page.locator(".symtoggle"), name).toHaveCount(0);
    } else {
      await expect(page.locator(".symtoggle .lbl"), name).toHaveText(x.toggle);
    }

    // zone b: diagnosis state
    if (x.diag === "empty") {
      await expect(page.locator(".diag-empty"), name).toBeVisible();
      await expect(page.locator(".verdict"), name).toHaveCount(0);
    } else {
      await expect(page.locator(".verdict"), name).toBeVisible();
      await expect(page.locator(".diag-empty"), name).toHaveCount(0);
      if (x.diag === "stale") {
        await expect(page.locator(".prov.stale"), name).toHaveCount(1);
        await expect(page.locator(".prov .edits"), name).toBeVisible();
        if (x.edits) await expect(page.locator(".prov .edits"), name).toHaveText(x.edits);
      } else {
        await expect(page.locator(".prov"), name).toHaveCount(1);
        await expect(page.locator(".prov.stale"), name).toHaveCount(0);
        await expect(page.locator(".prov .edits"), name).toHaveCount(0);
      }
    }

    // zone c: placeholder contract + pause menu rows (both tasks, honest
    // no-op count) — then the menu closes so the loop leaves a clean card
    await expect(page.locator(".cfoot textarea"), name).toHaveAttribute(
      "placeholder",
      x.placeholder,
    );
    await page.locator(".split > button").click();
    await expect(page.locator(".pmenu button"), name).toHaveCount(2);
    await expect(page.locator(".pmenu button.noop"), name).toHaveCount(x.noops);
    await page.keyboard.press("Escape");
    await expect(page.locator(".pmenu"), name).toHaveCount(0);
    await expect(page.locator(".modal"), name).toBeVisible();
  }
  expect(errors, errors.join("\n")).toHaveLength(0);
});

/* ── 1b. rev-2 (Wayne verdict ④): live rail under the open card ────────── */

test("conflict card gets the canvas-only scrim; the same pill toggles it closed", async ({ page }) => {
  await openRedViaPill(page);
  // same treatment as the panel: scrim starts at the rail/canvas seam, the
  // card centers over the CANVAS, and the rail stays undimmed + live
  const rail = (await page.locator(".rail").boundingBox())!;
  const scrim = (await page.locator(".scrim").boundingBox())!;
  expect(Math.abs(scrim.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);
  const modal = (await page.locator(".modal").boundingBox())!;
  expect(modal.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  await expect(page.locator(".rail")).not.toHaveClass(/dim/);
  // clicking the pill of the conflict already on screen = toggle close
  const pill = page.locator('[data-task="task-auto-retry-payments"] .pill');
  await pill.click();
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(pill).toBeFocused(); // focus-return rules unchanged
});

/* ── 2. inject feedback (preview stub, keyboard-driven end to end) ──────── */

test("inject with a typed note → SENT feedback, keyboard-reachable, close returns focus to the opener", async ({ page }) => {
  await openRedViaPill(page);

  // keyboard path: type the note, activate Inject with Enter
  await page.locator(".cfoot textarea").fill("Hold the state-machine file until #412 lands");
  await page.locator(".actions .send").focus();
  await page.keyboard.press("Enter");

  // optimistic feedback band replaces textarea + actions
  const band = page.locator(".fdbk");
  await expect(band).toBeVisible();
  await expect(band).toHaveAttribute("data-kind", "inject_note");
  await expect(band).toHaveAttribute("role", "status"); // announced, not stolen
  await expect(band.locator(".pill")).toHaveText("SENT");
  await expect(band.locator("p")).toContainText("Coordination note queued to both tasks");
  await expect(page.locator(".cfoot textarea")).toHaveCount(0);
  await expect(page.locator(".actions")).toHaveCount(0);

  // honesty disclosure: current v8 uses the visible mono "preview" marker;
  // the tooltip carries the stronger no-live-session qualification.
  const preview = band.locator(".preview");
  await expect(preview).toHaveText("preview");
  await expect(preview).toHaveAttribute("data-tip", /no live session received this/);

  // evidence zones stay readable behind the decision
  await expect(page.locator(".grade")).toBeVisible();
  await expect(page.locator(".verdict")).toBeVisible();

  // the outcome is one keystroke from done: Close is focused; Enter closes
  // and focus returns to the exact opener (the rail pill)
  await expect(band.locator(".quiet")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".modal")).toHaveCount(0);
  await expect(page.locator('[data-task="task-auto-retry-payments"] .pill')).toBeFocused();
});

test("inject with an EMPTY note + diagnosis → the send-time default, marked AI-suggested; seams recompute on the footer swap", async ({ page }) => {
  await openViaParam(page, "yellow-stale");

  // yellow @1280 clips → footer seam on before the action (S2/S4 behavior)
  await expect(page.locator(".cfoot.seam")).toHaveCount(1);

  await page.locator(".actions .send").click();
  const band = page.locator(".fdbk");
  await expect(band).toBeVisible();
  await expect(band.locator(".pill")).toHaveText("SENT");
  await expect(band.locator("p")).toContainText("Suggested line above is queued to both tasks");
  await expect(band.locator("p")).toContainText("marked as AI-suggested");
  await expect(band.locator(".pill")).toHaveAttribute("data-tip", /never as your words/);

  // the footer changed height → seams recomputed; the seam booleans must
  // agree with the body's real scroll metrics (not a stale snapshot)
  const consistent = await page.locator(".cbody").evaluate((b) => {
    const top = b.scrollTop > 0;
    const bottom = b.scrollTop + b.clientHeight < b.scrollHeight - 1;
    const grade = document.querySelector(".grade")!.classList.contains("seam");
    const foot = document.querySelector(".cfoot")!.classList.contains("seam");
    return top === grade && bottom === foot;
  });
  expect(consistent).toBe(true);
});

test("inject with an EMPTY note and NO diagnosis → nothing sent, the note field takes focus", async ({ page }) => {
  await openViaParam(page, "no-diagnosis");
  await page.locator(".actions .send").click();
  // no feedback band — an empty send with nothing to default to would be an
  // empty message; the honest response is handing focus to the note
  await expect(page.locator(".fdbk")).toHaveCount(0);
  await expect(page.locator(".cfoot textarea")).toBeFocused();
  await expect(page.locator(".actions")).toBeVisible();
});

/* ── 3. pause feedback ────────────────────────────────────────────────── */

test("pausing the running side (keyboard through the menu) → REQUESTED feedback naming both sides", async ({ page }) => {
  await openViaParam(page, "yellow-stale");

  // keyboard: Enter opens the menu, Tab reaches the first row, Enter picks it
  await page.locator(".split > button").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".pmenu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(".pmenu button").first()).toBeFocused();
  await page.keyboard.press("Enter");

  const band = page.locator(".fdbk");
  await expect(band).toBeVisible();
  await expect(band).toHaveAttribute("data-kind", "pause_side");
  await expect(band.locator(".pill")).toHaveText("REQUESTED");
  // names the requested side and boundary while withholding pickup/delivery.
  await expect(band.locator("p")).toContainText("next hook boundary");
  await expect(band.locator("p")).toContainText("pickup is not yet proven");
  await expect(band.locator(".preview")).toBeVisible();
  await expect(page.locator(".pmenu")).toHaveCount(0);
});

test("the waiting side stays an honest no-op: menu closes, NO feedback, actions intact", async ({ page }) => {
  await openViaParam(page, "yellow-stale");
  await page.locator(".split > button").click();
  await page.locator(".pmenu button.noop").click();
  await expect(page.locator(".pmenu")).toHaveCount(0);
  await expect(page.locator(".fdbk")).toHaveCount(0);
  await expect(page.locator(".actions .send")).toBeVisible();
  await expect(page.locator(".modal")).toBeVisible();
});

/* ── 4. ignore-pair: inline permanence gate ───────────────────────────── */

test("ignore asks one modest inline confirm; Keep (focused, safe default) and Escape both cancel", async ({ page }) => {
  await openViaParam(page, "osm-red-diagnosed");

  // click → inline confirm swaps in where the button sat; no browser dialog
  await page.locator(".actions .ignore").click();
  const confirm = page.locator(".confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm.locator(".q")).toHaveText("Silence this pair permanently?");
  await expect(page.locator(".actions .ignore")).toHaveCount(0);
  // focus lands on the SAFE option — Enter must not destroy
  await expect(confirm.locator(".keep")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".confirm")).toHaveCount(0);
  await expect(page.locator(".actions .ignore")).toBeVisible();
  await expect(page.locator(".fdbk")).toHaveCount(0);

  // Escape priority: confirm swallows the first Escape, the card the second
  await page.locator(".actions .ignore").click();
  await expect(page.locator(".confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".confirm")).toHaveCount(0);
  await expect(page.locator(".modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".modal")).toHaveCount(0);
});

test("confirming ignore → IGNORED feedback scoped to THIS pair; evidence stays readable", async ({ page }) => {
  await openViaParam(page, "osm-red-diagnosed");
  await page.locator(".actions .ignore").click();
  await page.locator(".confirm .doit").click();

  const band = page.locator(".fdbk");
  await expect(band).toBeVisible();
  await expect(band).toHaveAttribute("data-kind", "ignore_pair");
  await expect(band.locator(".pill")).toHaveText("IGNORED");
  await expect(band.locator("p")).toContainText("This task/branch pair is silenced");
  await expect(band.locator("p")).toContainText(
    "equivalent conflicts between these two sides won’t surface again",
  );
  await expect(band.locator(".preview")).toHaveText("preview");
  await expect(band.locator(".preview")).toHaveAttribute("data-tip", /no live session/);
  // the card stays open — the user can still read what they just silenced
  await expect(page.locator(".modal")).toBeVisible();
  await expect(page.locator(".side")).toHaveCount(2);
  await expect(band.locator(".quiet")).toBeFocused();
});

test("one open decision at a time: pause menu and ignore confirm displace each other", async ({ page }) => {
  await openViaParam(page, "osm-red-diagnosed");
  await page.locator(".split > button").click();
  await expect(page.locator(".pmenu")).toBeVisible();
  await page.locator(".actions .ignore").click();
  await expect(page.locator(".pmenu")).toHaveCount(0);
  await expect(page.locator(".confirm")).toBeVisible();
  await page.locator(".split > button").click();
  await expect(page.locator(".confirm")).toHaveCount(0);
  await expect(page.locator(".pmenu")).toBeVisible();
});

/* ── 5. run / re-run diagnosis stub (no fake progress) ────────────────── */

test("Re-run toggles an honest preview note — no fake progress, verdict untouched", async ({ page }) => {
  await openViaParam(page, "yellow-stale");
  const rerun = page.locator(".prov button");
  const verdictBefore = await page.locator(".verdict b").first().textContent();

  await rerun.click();
  const note = page.locator(".stubnote");
  await expect(note).toBeVisible();
  await expect(note).toContainText("Preview — nothing ran");
  await expect(note).toContainText("the verdict above refreshes in place");
  // `claude -p` renders as a mono code span (same rule as the verdict's)
  const code = note.locator(".code");
  await expect(code).toHaveText("claude -p");
  const font = await code.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toContain("ui-monospace");
  await expect(rerun).toHaveAttribute("aria-pressed", "true");
  // the verdict never changes — inventing a fresh one would be fabrication
  await expect(page.locator(".verdict b").first()).toHaveText(verdictBefore!);
  // stale marker stays honest too
  await expect(page.locator(".prov .edits")).toHaveText("· 3 edits since");

  // toggle off: the note yields its space back (DYNAMIC rule)
  await rerun.click();
  await expect(page.locator(".stubnote")).toHaveCount(0);
  await expect(rerun).toHaveAttribute("aria-pressed", "false");
});

test("Run AI diagnosis (empty state) toggles the same honest note inside the placeholder", async ({ page }) => {
  await openViaParam(page, "no-diagnosis");
  const run = page.locator(".diag-empty button").first();
  await run.click();
  const note = page.locator(".diag-empty .stubnote");
  await expect(note).toBeVisible();
  await expect(note).toContainText("the diagnosis fills in here");
  // still the dashed empty state — nothing pretends a verdict arrived
  await expect(page.locator(".verdict")).toHaveCount(0);
  await run.click();
  await expect(page.locator(".stubnote")).toHaveCount(0);
});

/* ── 6. 1200-symbol scroll perf sanity ────────────────────────────────── */

test("1200-symbol expand + scroll stays sane (smoke ceiling, seams correct, zero errors)", async ({ page }) => {
  const errors = collectErrors(page);
  await openViaParam(page, "1200-symbols");

  // expand: 3 → 1200 rows. The 3s ceiling is a broken-detector, not a perf
  // benchmark — an expand slower than that is unusable on any machine
  // (tunable; awaits a real perf budget).
  const t0 = Date.now();
  await page.locator(".symtoggle").click();
  await expect(page.locator(".sym")).toHaveCount(1200);
  expect(Date.now() - t0).toBeLessThan(3000);

  // scripted scroll sweep: bottom → middle → top; seams must track reality
  const body = page.locator(".cbody");
  for (const pos of ["bottom", "middle", "top"] as const) {
    await body.evaluate((b, p) => {
      b.scrollTo(
        0,
        p === "bottom" ? b.scrollHeight : p === "middle" ? b.scrollHeight / 2 : 0,
      );
    }, pos);
    await page.waitForTimeout(50);
    const ok = await body.evaluate((b) => {
      const top = b.scrollTop > 0;
      const bottom = b.scrollTop + b.clientHeight < b.scrollHeight - 1;
      return (
        top === document.querySelector(".grade")!.classList.contains("seam") &&
        bottom === document.querySelector(".cfoot")!.classList.contains("seam")
      );
    });
    expect(ok, `seams at ${pos}`).toBe(true);
  }

  // collapse yields the space back and the card is still fully interactive
  await body.evaluate((b) => b.scrollTo(0, 0));
  await page.locator(".symtoggle").click();
  await expect(page.locator(".sym")).toHaveCount(3);
  await page.locator(".actions .send").click(); // diagnosis present → default send
  await expect(page.locator(".fdbk .pill")).toHaveText("SENT");

  expect(errors, errors.join("\n")).toHaveLength(0);
});

/* ── 7. geometry at both viewports, busiest states ────────────────────── */

for (const vp of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`geometry @${vp.width}x${vp.height}: stress (12 expanded + textarea at cap + menu open) then feedback`, async ({ page }) => {
    await page.setViewportSize(vp);
    const errors = collectErrors(page);
    await openViaParam(page, "yellow-stale");

    // busiest pre-decision state: all symbols out, note at the 124px cap,
    // pause menu open — the S2 "stress" scenario, now against the live app
    await page.locator(".symtoggle").click();
    await expect(page.locator(".sym")).toHaveCount(12);
    const note = page.locator(".cfoot textarea");
    await note.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
    expect(Math.round(await note.evaluate((el) => el.getBoundingClientRect().height))).toBe(124);
    await page.locator(".split > button").click();
    await expect(page.locator(".pmenu")).toBeVisible();

    const probe = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const main = r(".main");
      const modal = r(".modal");
      const head = r(".chead");
      const grade = r(".grade");
      const body = r(".cbody");
      const foot = r(".cfoot");
      const menu = r(".pmenu");
      const el = document.querySelector<HTMLElement>(".cbody")!;
      return {
        modalInMain:
          modal.top >= main.top - 1 &&
          modal.bottom <= main.bottom + 1 &&
          modal.left >= main.left - 1 &&
          modal.right <= main.right + 1,
        stacked: head.bottom <= grade.top + 1 && grade.bottom <= body.top + 1 && body.bottom <= foot.top + 1,
        footPinned: Math.abs(foot.bottom - modal.bottom) <= 1,
        bodyIsScrollRegion: el.scrollHeight > el.clientHeight,
        pageNoScroll:
          document.documentElement.scrollHeight <= window.innerHeight &&
          document.documentElement.scrollWidth <= window.innerWidth,
        menuInViewport: menu.top >= 0 && menu.left >= 0 && menu.right <= window.innerWidth,
      };
    });
    expect(probe.modalInMain, "modal inside .main").toBe(true);
    expect(probe.stacked, "header/grade/body/foot stacked, no overlap").toBe(true);
    expect(probe.footPinned, "footer pinned to the modal bottom").toBe(true);
    expect(probe.bodyIsScrollRegion, ".cbody is the (only) scroll region").toBe(true);
    expect(probe.pageNoScroll, "no page-level scroll").toBe(true);
    expect(probe.menuInViewport, "pause menu fully visible").toBe(true);

    // busiest post-decision state: feedback band in place of the actions
    await page.keyboard.press("Escape"); // menu first (priority ladder)
    await page.locator(".actions .send").click();
    await expect(page.locator(".fdbk")).toBeVisible();
    const band = await page.evaluate(() => {
      const foot = document.querySelector(".cfoot")!.getBoundingClientRect();
      const modal = document.querySelector(".modal")!.getBoundingClientRect();
      const b = document.querySelector(".fdbk")!.getBoundingClientRect();
      return {
        inFoot: b.top >= foot.top - 1 && b.bottom <= foot.bottom + 1,
        footStillPinned: Math.abs(foot.bottom - modal.bottom) <= 1,
        noXOverflow: b.left >= modal.left && b.right <= modal.right,
      };
    });
    expect(band.inFoot, "feedback band inside the footer").toBe(true);
    expect(band.footStillPinned, "footer still pinned after the swap").toBe(true);
    expect(band.noXOverflow, "band has no horizontal overflow").toBe(true);

    expect(errors, errors.join("\n")).toHaveLength(0);
  });
}
