/** Test-only fixture harness compatibility. Production bootstrap is separate. */
import { expect, test } from "@playwright/test";
import { BASE } from "./env";

test("unknown fixture name still falls through to the default map", async ({ page }) => {
  await page.goto(`${BASE}/?fixture=definitely-not-real&switcher=0`);
  await expect(page.locator(".wordmark")).toBeVisible();
  await expect(page.locator(".canvas")).toBeVisible();
});
