import { describe, expect, it } from "vitest";
import type { AppliedIntervention, WorkbenchIntervention } from "@vibehub/core/contracts";
import {
  deriveInterventionNote,
  WORKBENCH_INTERVENTION_TRIGGER,
} from "../../src/receipt-note-derive";

const at = "2026-07-12T10:22:00.000Z";
const inject: WorkbenchIntervention = {
  kind: "inject", taskId: "task:abc", text: "Preserve the retry evidence.",
};
const pause: WorkbenchIntervention = {
  kind: "pause", taskId: "task:abc", text: "Stop — let's talk.",
};
const injectBoth: WorkbenchIntervention = {
  kind: "inject_both", conflictId: "conflict-osm", text: "Coordinate.",
};
const ignorePair: WorkbenchIntervention = { kind: "ignore_pair", conflictId: "conflict-osm" };

function applied(
  outcome: AppliedIntervention["outcome"],
  injectionIds: number[],
  extra: Partial<AppliedIntervention> = {},
): AppliedIntervention {
  return {
    requestId: `request-${outcome}`,
    outcome,
    injectionIds,
    affectedTaskIds: ["task:abc"],
    acceptedAt: at,
    ...extra,
  };
}

describe("deriveInterventionNote (one receipt truth, honest fallback)", () => {
  it("describes the bridge trigger as a request rather than a successful effect", () => {
    expect(WORKBENCH_INTERVENTION_TRIGGER).toContain("requested");
    expect(WORKBENCH_INTERVENTION_TRIGGER).not.toMatch(/queued|applied/i);
  });

  it("projects strong-evidence successes to the shared queued outcome", () => {
    expect(deriveInterventionNote(inject, applied("applied", [41])).receiptOutcome).toBe("queued");
    expect(deriveInterventionNote(pause, applied("applied", [7])).receiptOutcome).toBe("queued");
    expect(deriveInterventionNote(injectBoth, applied("applied", [41, 42])).receiptOutcome).toBe("queued");
    expect(deriveInterventionNote(inject, applied("already_applied", [41], { replayed: true })).receiptOutcome)
      .toBe("queued");
  });

  it("projects honest non-success outcomes to skipped and failed", () => {
    expect(deriveInterventionNote(inject, applied("stale", [])).receiptOutcome).toBe("skipped");
    expect(deriveInterventionNote(inject, applied("no_op", [])).receiptOutcome).toBe("skipped");
    expect(deriveInterventionNote(inject, applied("unsupported", [])).receiptOutcome).toBe("failed");
  });

  it("never upgrades weak evidence — success without persisted ids falls back to the raw outcome", () => {
    for (const weak of [
      deriveInterventionNote(inject, applied("applied", [])),
      deriveInterventionNote(inject, applied("already_applied", [])),
      deriveInterventionNote(injectBoth, applied("applied", [41])),
      deriveInterventionNote(inject, applied("applied", [41, 41])),
      deriveInterventionNote(inject, applied("applied", [0])),
    ]) {
      expect(weak.receiptOutcome).toBeNull();
      expect(weak.result.outcome).toMatch(/applied/);
    }
  });

  it("leaves non-injection interventions on the raw outcome path", () => {
    const note = deriveInterventionNote(ignorePair, applied("applied", []));
    expect(note.receiptOutcome).toBeNull();
    expect(note.result.outcome).toBe("applied");
  });

  it("preserves the raw result untouched for every path", () => {
    const result = applied("applied", [41], { message: "Queued for the next hook boundary." });
    const note = deriveInterventionNote(inject, result);
    expect(note.result).toBe(result);
    expect(note.result.message).toBe("Queued for the next hook boundary.");
  });
});
