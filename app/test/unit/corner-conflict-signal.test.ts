import { describe, expect, it } from "vitest";
import { clampCornerPosition, parseCornerPosition } from "../../src/components/CornerConflictSignal";

describe("corner conflict signal geometry", () => {
  it("clamps compact position inside the canvas with an eight pixel inset", () => {
    expect(clampCornerPosition(
      { x: -20, y: 900 },
      { width: 460, height: 300 },
      { width: 280, height: 92 },
    )).toEqual({ x: 8, y: 200 });
  });

  it("keeps a valid compact position unchanged", () => {
    expect(clampCornerPosition(
      { x: 80, y: 60 },
      { width: 700, height: 500 },
      { width: 280, height: 92 },
    )).toEqual({ x: 80, y: 60 });
  });

  it("rejects malformed persisted positions and keeps finite coordinates", () => {
    expect(parseCornerPosition("not-json")).toBeNull();
    expect(parseCornerPosition('{"x":10,"y":"20"}')).toBeNull();
    expect(parseCornerPosition('{"x":10,"y":20}')).toEqual({ x: 10, y: 20 });
  });
});
