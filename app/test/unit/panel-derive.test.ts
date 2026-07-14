import { describe, expect, it } from "vitest";
import { deckPlaceholder } from "../../src/panel-derive";
import { pauseFeedback, pauseRows } from "../../src/conflict-derive";
import { conflictOsmRedDiagnosed } from "../fixtures";

describe("pause copy", () => {
  it("describes a queued boundary request and never promises stopped or resume", () => {
    const copy = [
      deckPlaceholder("running", "pause"),
      ...pauseRows(conflictOsmRedDiagnosed).flatMap((row) => [row.st, row.tip]),
      pauseFeedback(conflictOsmRedDiagnosed, conflictOsmRedDiagnosed.tasks[0]!).text,
      pauseFeedback(conflictOsmRedDiagnosed, conflictOsmRedDiagnosed.tasks[0]!).tip,
    ].join(" ");

    expect(copy).toMatch(/queue|request/i);
    expect(copy).toMatch(/boundary|hook/i);
    expect(copy).not.toMatch(/stop first|stays stopped|stopped until|resume/i);
  });

  it("queues a waiting-task reply without claiming pickup or delivery", () => {
    const copy = deckPlaceholder("waiting", "inject");

    expect(copy).toMatch(/queue/i);
    expect(copy).toMatch(/hook|turn boundary/i);
    expect(copy).not.toMatch(/lands immediately|deliver|receive|pick(?:ed)? up/i);
  });
});
