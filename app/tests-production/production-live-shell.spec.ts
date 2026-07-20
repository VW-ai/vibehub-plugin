import { expect, test } from "@playwright/test";
import { identityRecoveryLiveShell, liveShellBaseline, mappedPartialLiveShell, unavailableLiveShell } from "../test/fixtures";
import { installProductionHost, openProduction, taskCard } from "./helpers";

test("live shell preserves exact identity and separate activation proof", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const activation = page.getByRole("region", { name: "Activation evidence" });
  await expect(activation).toContainText("codex");
  await expect(activation).toContainText("/tmp/production-e2e");
  await expect(activation).toContainText("/tmp/production-e2e/worktrees/live-shell");
  await expect(activation.locator('[data-proof="proven"]')).toHaveCount(2);
  await expect(activation.locator('[data-proof="not_proven"]')).toContainText("Activated");
  await expect(page.getByText("β compatibility authority")).toBeVisible();
});

test("identity recovery and activation evidence are visible rather than title-only", async ({ page }) => {
  await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: identityRecoveryLiveShell }) });
  await openProduction(page);
  const activation = page.getByRole("region", { name: "Activation evidence" });
  await expect(activation).toContainText("Identity: partial");
  await expect(activation).toContainText("Retry the identity read from the native host.");
  await expect(activation).toContainText("managed assets present");
  await expect(activation).toContainText("native bridge response");
  await expect(activation).toContainText("no activation receipt");
});

test("section failures remain local and an unavailable workspace is never fabricated", async ({ page }) => {
  await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: unavailableLiveShell }) });
  await openProduction(page);
  await expect(page.getByText("Workspace evidence unavailable")).toBeVisible();
  await expect(page.getByText("Initialize this repository before reading workspace evidence.")).toBeVisible();
  await expect(page.locator(".canvas,.rail")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Activation evidence" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Context feedback evidence" })).toBeVisible();
});

test("partial stale activation recovery stays textual while the workspace remains live", async ({ page }) => {
  const partial = {
    ...liveShellBaseline,
    activation: {
      ...liveShellBaseline.activation,
      availability: "partial" as const,
      freshness: "stale" as const,
      recovery: [{ code: "inspect_activation" as const, instruction: "Inspect recorded activation evidence in the host." }],
    },
  };
  await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: partial }) });
  await openProduction(page);
  const activation = page.getByRole("region", { name: "Activation evidence" });
  await expect(activation).toContainText("Activation: partial");
  await expect(activation).toContainText("stale evidence");
  await expect(activation).toContainText("Inspect recorded activation evidence in the host.");
  await expect(activation.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".canvas")).toBeVisible();
});

test("context feedback keeps four receipt lanes and raw outcomes", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const dock = page.getByRole("region", { name: "Context feedback evidence" });
  for (const [lane, outcome] of [["retrieval", "returned"], ["operational_capture", "verified"], ["explicit_proposal", "returned"], ["durable_mutation", "persisted"]] as const) {
    const receipt = dock.locator(`[data-lane="${lane}"] .feedback-receipt`).first();
    await expect(receipt).toContainText(outcome);
    for (const field of ["Activity", "Trigger", "Effects", "Result", "Next"]) await expect(receipt).toContainText(field);
  }
  await expect(dock).not.toContainText(/delivered|activated successfully/i);
});

test("mapped partial workspace exposes protocol evidence without replacing map interactions", async ({ page }) => {
  await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: mappedPartialLiveShell }) });
  await openProduction(page);
  const workspace = page.getByRole("region", { name: "Workspace evidence" });
  const evidence = workspace.locator(".workspace-evidence-bar");
  await expect(evidence).toContainText("Workspace: partial");
  await expect(evidence).toContainText("Refactor auth flow · waiting");
  await expect(evidence).toContainText("session-live-17");
  await expect(evidence).toContainText("codex");
  await expect(evidence).toContainText("active");
  await expect(evidence).toContainText(/Declared scope/i);
  await expect(evidence).toContainText("write · app/src/** · Workbench UI");
  await expect(evidence).toContainText("read · packages/core/src/contract/** · unlabeled");
  await expect(evidence).not.toContainText(/territoryId|filesTouched/);
  await expect(evidence).toContainText(/Observed.*1 read.*2 write/i);
  await expect(evidence).toContainText(/Timeline.*1/i);
  await expect(evidence).toContainText(/Receipts.*4/i);
  for (const source of ["operation request", "intervention queue", "injection claim", "checkpoint"]) await expect(evidence).toContainText(new RegExp(source, "i"));
  await taskCard(page, "task-refactor-auth").click();
  await expect(page.locator(".panel")).toBeVisible();
});

test("live shell retains detail interactions and exposes no fabricated lifecycle controls", async ({ page }) => {
  await installProductionHost(page);
  await openProduction(page);
  const opener = taskCard(page, "task-refactor-auth");
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".panel")).toBeVisible();
  await expect(page.getByRole("button", { name: /switch repo|activate|doctor|capture|launch|resume|terminate|complete/i })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(opener).toBeFocused();
});

for (const viewport of [{ width: 900, height: 700 }, { width: 760, height: 700 }]) {
  test(`live shell contains its rail, panel, and evidence at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: mappedPartialLiveShell }) });
    await openProduction(page);
    await taskCard(page, "task-refactor-auth").click();
    const rail = (await page.locator(".rail").boundingBox())!;
    const panel = (await page.locator(".panel").boundingBox())!;
    expect(panel.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(page.locator(".window")).toHaveCSS("animation-name", "none");
    await expect(page.getByRole("region", { name: "Activation evidence" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Context feedback evidence" })).toBeVisible();
    await expect(page.getByText("Sync repository evidence before relying on this workspace view.")).toBeVisible();
    await expect(page.getByText("Inspect checkpoint receipt coverage.")).toBeVisible();
  });
}

test("new compact evidence text uses the accessible dark ink token", async ({ page }) => {
  await installProductionHost(page, { getLiveShell: () => ({ status: "ok", data: mappedPartialLiveShell }) });
  await openProduction(page);
  const secondary = page.locator(".evidence-secondary");
  expect(await secondary.count()).toBeGreaterThan(0);
  for (const item of await secondary.all()) {
    await expect(item).toHaveCSS("color", "rgb(60, 63, 69)");
  }
});
