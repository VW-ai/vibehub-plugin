import assert from "node:assert/strict";
import { test } from "node:test";
import { measureDenseLayouts } from "../scripts/measure-graph-layout.mjs";

test("dense routing materially reduces crossings and coincident segments against exact baselines", () => {
  const report = measureDenseLayouts();
  assert.equal(report.reduction.crossings >= 30, true, JSON.stringify(report.aggregate));
  assert.equal(report.reduction.coincidentLength >= 25, true, JSON.stringify(report.aggregate));
  for (const comparison of report.comparisons) {
    assert.equal(
      comparison.optimized.crossings <= comparison.baseline.crossings * 1.05,
      true,
      `${comparison.fixture} ${comparison.direction} ${comparison.viewport} crossing regression`,
    );
    assert.equal(
      comparison.optimized.coincidentLength <= comparison.baseline.coincidentLength * 1.05,
      true,
      `${comparison.fixture} ${comparison.direction} ${comparison.viewport} congestion regression`,
    );
  }
});
