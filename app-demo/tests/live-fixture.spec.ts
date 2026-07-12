/**
 * M1 ④ live path — `?fixture=live` boots through the async fixture
 * resolution (fetch /live-fixture.json → SQLite via the vite middleware, or
 * static export, or honest fallback to the default fixture). Whatever the
 * machine's DB state, the app MUST render a working map: the boot path is
 * the regression surface here, not the data content (which is this
 * machine's real repo state — deliberately non-deterministic).
 */
import { expect, test } from "@playwright/test";
import { BASE } from "./env";

test("?fixture=live boots to a rendered map (live data or honest fallback)", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await page.goto(`${BASE}/?fixture=live&switcher=0`);

  // the app booted through resolveFixtures() and rendered a map frame
  await expect(page.locator(".wordmark")).toBeVisible();
  await expect(page.locator(".canvas")).toBeVisible();

  // whichever branch it took, it must be an honest one:
  const live = await page.evaluate(async () => {
    const res = await fetch("/live-fixture.json");
    return res.ok;
  });
  if (!live) {
    // no live data on this machine → the fallback warned about it
    expect(warnings.join("\n")).toContain("live fixture unavailable");
  }
});

test("unknown fixture name still falls through to the default map", async ({ page }) => {
  await page.goto(`${BASE}/?fixture=definitely-not-real&switcher=0`);
  await expect(page.locator(".wordmark")).toBeVisible();
  await expect(page.locator(".canvas")).toBeVisible();
});
