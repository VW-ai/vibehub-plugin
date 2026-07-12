/**
 * Unit tests for the chip derivation rules revised at Wayne's 2026-07-12
 * live review (rev-1): middleTruncate (pure), the wrap-by-default chip rule,
 * and the >PATHOLOGICAL_MAX +N fallback. Fixture-facing cases run against
 * extreme-scope-overload (the same data the e2e wrap tests render).
 */
import { describe, expect, it } from "vitest";
import {
  BRANCH_CHIP_MAX,
  PATHOLOGICAL_MAX,
  middleTruncate,
  taskChips,
} from "./derive";
import type { MapFixture, ScopeDeclaration, Task } from "./types";
import { extremeScopeOverload } from "./fixtures/extreme-scope-overload";

const overload: MapFixture = extremeScopeOverload;

function taskById(id: string): Task {
  const t = overload.tasks.find((t) => t.id === id);
  if (!t) throw new Error(`fixture task ${id} missing`);
  return t;
}

describe("middleTruncate", () => {
  it("returns short text unchanged", () => {
    expect(middleTruncate("main", 28)).toBe("main");
  });

  it("returns text of exactly max length unchanged (no gratuitous ellipsis)", () => {
    const s = "x".repeat(28);
    expect(middleTruncate(s, 28)).toBe(s);
  });

  it("returns the empty string unchanged", () => {
    expect(middleTruncate("", 28)).toBe("");
  });

  it("truncates the MIDDLE, preserving head and tail (Wayne's review example shape)", () => {
    const out = middleTruncate("vibehub/auto-retry-failed-payments", 28);
    expect(out).toBe("vibehub/auto-r…iled-payments");
    expect(out.startsWith("vibehub/")).toBe(true); // org prefix survives
    expect(out.endsWith("payments")).toBe(true); // subject tail survives
  });

  it("output length is exactly max when truncating", () => {
    for (const max of [5, 10, 28, 40]) {
      expect(middleTruncate("a".repeat(200), max)).toHaveLength(max);
    }
  });

  it("contains exactly one ellipsis when truncating", () => {
    const out = middleTruncate("feature/very-long-branch-name-here", 20);
    expect(out.split("…")).toHaveLength(2);
  });

  it("head gets the extra character on odd budgets", () => {
    // max 6 → head 3, tail 2
    expect(middleTruncate("abcdefghij", 6)).toBe("abc…ij");
  });

  it("degenerate budgets (max ≤ 1) collapse to a bare ellipsis", () => {
    expect(middleTruncate("abcdef", 1)).toBe("…");
    expect(middleTruncate("abcdef", 0)).toBe("…");
    expect(middleTruncate("", 0)).toBe("");
  });

  it("never truncates below the text's own length", () => {
    expect(middleTruncate("ab", 2)).toBe("ab");
    expect(middleTruncate("a", 1)).toBe("a");
  });
});

describe("taskChips — wrap-by-default rule (rev-1)", () => {
  it("9 scopes + branch = 10 chips, ALL visible, no +N (old collapse revoked)", () => {
    const chips = taskChips(taskById("task-nine-scopes"), overload);
    expect(chips).toHaveLength(10);
    expect(chips.some((c) => c.kind === "more")).toBe(false);
    // branch chip is last and shows the FULL branch (25 chars ≤ budget)
    expect(chips[chips.length - 1]).toMatchObject({
      kind: "n",
      label: "acme/unify-error-handling",
    });
  });

  it("long branch names get middle truncation on the chip, exact text in the tooltip", () => {
    const chips = taskChips(taskById("task-long-title"), overload);
    const branch = chips[chips.length - 1]!;
    expect(branch.kind).toBe("n");
    expect(branch.label).toBe(
      middleTruncate("acme/fix-payments-gateway-502s", BRANCH_CHIP_MAX),
    );
    expect(branch.label).toContain("…");
    expect(branch.label.length).toBeLessThanOrEqual(BRANCH_CHIP_MAX);
    expect(branch.tip).toContain("branch acme/fix-payments-gateway-502s");
  });

  it(`pathological count (>${PATHOLOGICAL_MAX}) falls back to +N`, () => {
    const chips = taskChips(taskById("task-pathological-scopes"), overload);
    // 14 scopes + branch = 15 → first 11 + one "+4"
    expect(chips).toHaveLength(PATHOLOGICAL_MAX);
    const more = chips[chips.length - 1]!;
    expect(more.kind).toBe("more");
    expect(more.label).toBe("+4");
    // the +N tooltip spells out everything hidden: branch + reads (deduped)
    expect(more.tip).toContain("branch acme/audit-error-propagation-sweep");
    expect(more.tip).toContain(
      "reads Infra & Deploy, Vendored Monolith Compatibility Shims",
    );
    // two hidden registrations in Infra & Deploy read as ONE line of truth
    expect(more.tip.match(/Infra & Deploy/g)).toHaveLength(1);
  });

  it("exactly PATHOLOGICAL_MAX chips stay fully visible (boundary is exclusive)", () => {
    const scopes: ScopeDeclaration[] = Array.from({ length: PATHOLOGICAL_MAX - 1 }, (_, i) => ({
      mode: "read" as const,
      territoryId: "x-auth",
      label: `auth/path-${i}`,
    }));
    const task: Task = {
      ...taskById("task-nine-scopes"),
      id: "task-boundary",
      scopes,
    };
    const chips = taskChips(task, overload);
    expect(chips).toHaveLength(PATHOLOGICAL_MAX); // 11 scopes + branch
    expect(chips.some((c) => c.kind === "more")).toBe(false);
  });

  it("scope chips keep tail semantics (label verbatim, mode-prefixed) — no middle truncation", () => {
    const chips = taskChips(taskById("task-nine-scopes"), overload);
    expect(chips[0]!.label).toBe("w core");
    expect(chips[8]!.label).toBe("r vendored-monolith-compat"); // full text; CSS ellipsizes
  });

  it("done + merged PR still renders the single git-fact chip", () => {
    const doneTask: Task = {
      ...taskById("task-nine-scopes"),
      id: "task-done",
      state: "done",
      git: {
        branch: "acme/unify-error-handling",
        prNumber: 41,
        prState: "merged",
      },
    };
    const chips = taskChips(doneTask, overload);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.label).toBe("PR #41 merged");
  });
});
