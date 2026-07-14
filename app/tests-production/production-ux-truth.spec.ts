import { expect, test } from "@playwright/test";
import { installProductionHost, openProduction, taskCard } from "./helpers";

test("unsupported production affordances are disabled or non-interactive", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);

  const repo = page.locator(".titlebar .repo");
  const fresh = page.locator(".titlebar .fresh");
  for (const label of [repo, fresh]) {
    await expect(label).not.toHaveAttribute("role", "button");
    await expect(label).not.toHaveAttribute("tabindex");
    await expect(label).toHaveCSS("cursor", "default");
    await expect(label).not.toHaveAttribute("data-tip", /switch|click|choose/i);
  }

  const launch = page.getByRole("button", { name: /Start a task.*unavailable/i });
  await expect(launch).toBeDisabled();

  await taskCard(page, "task-refactor-auth").click();
  const panel = page.locator(".panel");
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText(/Resume|Terminate|Mark done/i);
  await expect(panel.locator('[data-tip*="stays stopped"]')).toHaveCount(0);
});

test("production conflict detail exposes recorded evidence without a diagnosis action promise", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);

  await page.locator('[data-task="task-auto-retry-payments"] .pill').click();
  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByRole("heading", { name: "Recorded diagnosis" })).toBeVisible();
  await expect(conflict.getByRole("button", { name: /Run AI diagnosis|Re-run/i })).toHaveCount(0);
  await expect(conflict).not.toContainText(/Run AI diagnosis|Re-run/);
});

test("pause production copy only claims a queued boundary request", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  await taskCard(page, "task-refactor-auth").click();

  const panel = page.locator(".panel");
  await panel.getByRole("button", { name: "Pause & think together" }).click();
  const textarea = panel.locator("textarea");
  await expect(textarea).toHaveAttribute("placeholder", /queue|request/i);
  await expect(textarea).toHaveAttribute("placeholder", /boundary|hook/i);
  await expect(panel).not.toContainText(/Resume|stays stopped|stop first/i);
});

test("production conflict pause receipt claims request acceptance, not pickup or stop", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  await page.locator('[data-task="task-auto-retry-payments"] .pill').click();

  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  await conflict.getByRole("button", { name: "Pause one side" }).click();
  await conflict.getByRole("menuitem").filter({ hasNot: page.locator(".noop") }).first().click();

  const status = conflict.getByRole("status");
  await expect(status).toContainText("REQUESTED");
  await expect(status).toContainText(/not shown as stopped/i);
  await expect(status).not.toContainText(/delivered|picked up|has stopped/i);
});

test("v8 production focus rings, compact targets, and reduced motion stay accessible", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installProductionHost(page);
  await openProduction(page);

  const conflictStat = page.locator('.titlebar .stat[role="button"]');
  await conflictStat.focus();
  await expect(conflictStat).toHaveCSS("outline-color", "rgb(72, 105, 156)");
  await expect(conflictStat).toHaveCSS("outline-width", "2px");
  await conflictStat.press("Enter");

  const conflict = page.getByRole("dialog", { name: /Conflict:/ });
  await expect(conflict).toHaveCSS("animation-name", "none");
  const close = conflict.getByRole("button", { name: "Close conflict card" });
  await close.focus();
  await expect(close).toHaveCSS("outline-color", "rgb(72, 105, 156)");
  await close.click();

  await taskCard(page, "task-refactor-auth").click();
  const panel = page.locator(".panel");
  for (const control of [panel.locator(".seg button").first(), panel.locator(".filestoggle").first()]) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await control.focus();
    // Re-enter the target through keyboard navigation so Chromium applies
    // :focus-visible (programmatic focus after the preceding clicks does not).
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS("outline-color", "rgb(72, 105, 156)");
  }
});
