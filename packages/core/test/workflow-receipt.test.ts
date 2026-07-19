import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { operationInputSchemas } from "../src/operation-contracts.js";
import {
  CANONICAL_OPERATION_PRESENTATION,
  renderWorkflowReceiptText,
  validateWorkflowReceiptStructure,
  type WorkflowReceiptV1,
} from "../src/contract/workflow-receipt.js";
import {
  OPERATION_PRESENTATION,
  projectCheckpointReceipt,
  projectDoctorReceipt,
  projectInjectionClaimReceipt,
  projectInjectionInterventionReceipt,
  projectOperationReceipt,
} from "../src/workflow-receipt-projectors.js";
import type { CheckpointCadenceFacts } from "../src/knowledge-checkpoint.js";

const at = "2026-07-18T12:00:00.000Z";
const success = (operation: string, data: unknown = {}) => ({
  ok: true as const,
  data,
  meta: { operation, repoId: 7, requestId: "request-1", at },
});
const failure = {
  ok: false as const,
  error: {
    code: "cas_conflict",
    message: "the active version changed",
    details: null,
    nextSafeActions: ["Re-read the active version before retrying."],
  },
};

describe("operation receipt projection", () => {
  it("exhaustively maps every canonical operation without caller-selected activity or effect", () => {
    expect(OPERATION_PRESENTATION).toBe(CANONICAL_OPERATION_PRESENTATION);
    expect(Object.keys(OPERATION_PRESENTATION).sort()).toEqual(Object.keys(operationInputSchemas).sort());
    expect(OPERATION_PRESENTATION["kb.spec.search"]).toEqual({ activity: "query", effect: "read" });
    expect(OPERATION_PRESENTATION["kb.review"]).toEqual({ activity: "review", effect: "read" });
    expect(OPERATION_PRESENTATION["kb.amend"]).toEqual({ activity: "update", effect: "write" });
    expect(OPERATION_PRESENTATION["distill.activate"]).toEqual({ activity: "distill", effect: "write" });
  });

  it("projects a failed mutation as failed with source identity and mandatory recovery", () => {
    const receipt = projectOperationReceipt({
      trigger: "The agent found a durable correction.",
      attempt: { operation: "kb.amend", repoId: 7, requestId: "request-1", at },
      result: failure,
      visibility: "silent",
      nextAction: null,
    });

    expect(receipt).toMatchObject({
      activity: "update",
      outcome: "failed",
      visibility: "expanded",
      nextAction: { required: true, instruction: "Re-read the active version before retrying." },
      evidence: [{
        source: "operation_result",
        operation: "kb.amend",
        repoId: 7,
        requestId: "request-1",
        ok: false,
        effect: "write",
        outcome: "failed",
      }],
    });
  });

  it("returns an empty query honestly with an explicit zero item count", () => {
    const receipt = projectOperationReceipt({
      trigger: "Context is needed before an edit.",
      result: success("kb.spec.search", { items: [], total: 0 }),
    });
    expect(receipt).toMatchObject({
      activity: "query",
      outcome: "returned",
      evidence: [{
        operation: "kb.spec.search",
        effect: "read",
        ok: true,
        subject: "kb.spec.search request request-1",
        returnedCount: 0,
        totalCount: 0,
      }],
    });
    expect(JSON.stringify(receipt)).not.toContain("activated");
    expect(projectOperationReceipt({
      trigger: "paged query",
      result: success("kb.spec.search", { items: ["a", "b"], total: 100 }),
    }).evidence[0]).toMatchObject({ returnedCount: 2, totalCount: 100 });
  });

  it("rejects unknown operations and mismatched success provenance", () => {
    expect(() => projectOperationReceipt({
      trigger: "test",
      result: success("future.unknown"),
    })).toThrow(/unknown canonical operation/);
    expect(() => projectOperationReceipt({
      trigger: "test",
      attempt: { operation: "kb.spec.get", repoId: 7, requestId: "request-1", at },
      result: success("kb.spec.search"),
    })).toThrow(/does not match/);
  });
});

describe("setup and injection evidence boundaries", () => {
  const greenDoctor = {
    schemaVersion: 1 as const,
    healthy: true,
    db: {
      status: "healthy" as const,
      path: "/tmp/workbench.db",
      schemaVersion: 14,
      expectedSchemaVersion: 14,
      sqliteVersion: "3.47.2",
    },
    nativeDependency: { status: "healthy" as const, module: "better-sqlite3" as const },
    repo: { status: "healthy" as const, root: "/repo", id: 7 },
    managedAssets: { status: "healthy" as const, releaseVersion: "0.0.1", assets: [] },
  };

  it("recomputes doctor health and rejects a contradictory healthy boolean", () => {
    expect(projectDoctorReceipt({
      trigger: "Setup health check.",
      result: greenDoctor,
      at,
    }).outcome).toBe("verified");
    expect(() => projectDoctorReceipt({
      trigger: "Setup health check.",
      result: { ...greenDoctor, db: { ...greenDoctor.db, status: "missing" } },
      at,
    })).toThrow(/contradicts component statuses/);
  });

  it("queues only injection interventions with valid persisted queue ids", () => {
    const receipt = projectInjectionInterventionReceipt({
      trigger: "The user asked to pass context.",
      intervention: { kind: "inject", taskId: "task-auth", text: "Coordinate first." },
      result: {
        requestId: "inject-1",
        outcome: "applied",
        injectionIds: [41],
        affectedTaskIds: ["task-auth"],
        acceptedAt: at,
      },
    });
    expect(receipt).toMatchObject({
      outcome: "queued",
      evidence: [{
        source: "applied_intervention",
        originalKind: "inject",
        injectionIds: [41],
      }],
    });

    for (const injectionIds of [[], [0], [1, 1], [Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => projectInjectionInterventionReceipt({
        trigger: "test",
        intervention: { kind: "inject", taskId: "task-auth", text: "x" },
        result: {
          requestId: "inject-bad",
          outcome: "applied",
          injectionIds,
          affectedTaskIds: ["task-auth"],
          acceptedAt: at,
        },
      })).toThrow(/injection ids/i);
    }
    expect(() => projectInjectionInterventionReceipt({
      trigger: "test",
      intervention: { kind: "ignore_pair", conflictId: "conflict-1" } as never,
      result: {
        requestId: "not-an-injection",
        outcome: "applied",
        injectionIds: [41],
        affectedTaskIds: [],
        acceptedAt: at,
      },
    })).toThrow(/originalKind/);
  });

  it("never upgrades no-op, stale, or unsupported intervention replays to queued", () => {
    for (const outcome of ["no_op", "stale", "unsupported"] as const) {
      const receipt = projectInjectionInterventionReceipt({
        trigger: "test",
        intervention: { kind: "pause", taskId: "task-auth", text: "wait" },
        result: {
          requestId: `inject-${outcome}`,
          outcome,
          replayed: true,
          injectionIds: [],
          affectedTaskIds: ["task-auth"],
          acceptedAt: at,
        },
      });
      expect(receipt.outcome).not.toBe("queued");
    }
  });

  it("accepts complete mechanical claims and rejects invalid claim ids", () => {
    const claimed = [{
      id: 41,
      mode: "inject" as const,
      text: "Coordinate first.",
      context: "auth",
      createdAt: at,
    }];
    const receipt = projectInjectionClaimReceipt({
      trigger: "A delivery-capable hook checked the queue.",
      taskId: "task-auth",
      claimed,
      hookEvent: "UserPromptSubmit",
      at,
    });
    expect(receipt).toMatchObject({
      outcome: "claimed",
      evidence: [{
        source: "hook_evidence",
        injectionIds: [41],
        injectionModes: ["inject"],
      }],
    });
    expect(JSON.stringify(receipt)).not.toMatch(/delivered|acknowledged/);
    expect(() => projectInjectionClaimReceipt({
      trigger: "test", taskId: "task-auth", hookEvent: "Stop", at,
      claimed: [{ ...claimed[0]!, id: 0 }],
    })).toThrow(/injection ids/i);
  });
});

describe("strict receipt structure and safety matrix", () => {
  const persisted: WorkflowReceiptV1 = {
    schemaVersion: 1,
    activity: "update",
    phase: "complete",
    outcome: "persisted",
    visibility: "brief",
    trigger: "A durable correction was accepted.",
    evidence: [{
      source: "operation_result",
      operation: "kb.amend",
      repoId: 7,
      requestId: "request-1",
      ok: true,
      effect: "write",
      outcome: "persisted",
      subject: "kb.amend request request-1",
    }],
    nextAction: null,
    at,
  };

  it("rejects source spoofing, extra fields, invalid phase combinations, and silent failures", () => {
    const variants: unknown[] = [
      { ...persisted, evidence: [{ ...persisted.evidence[0], source: "hook_evidence" }] },
      { ...persisted, evidence: [{ ...persisted.evidence[0], operation: "kb.status" }] },
      { ...persisted, surprise: true },
      { ...persisted, phase: "prepare" },
      { ...persisted, outcome: "failed", visibility: "silent" },
      { ...persisted, outcome: "waiting", nextAction: null },
    ];
    for (const value of variants) expect(validateWorkflowReceiptStructure(value).ok).toBe(false);
  });

  it("recomputes doctor/init truth and enforces queued intervention cardinality", () => {
    const doctor = projectDoctorReceipt({
      trigger: "doctor",
      result: {
        schemaVersion: 1,
        healthy: true,
        db: { status: "healthy", path: "/tmp/db", schemaVersion: 14, expectedSchemaVersion: 14, sqliteVersion: "3" },
        nativeDependency: { status: "healthy", module: "better-sqlite3" },
        repo: { status: "healthy", root: "/repo", id: 7 },
        managedAssets: { status: "healthy", releaseVersion: "1", assets: [] },
      },
      at,
    });
    expect(validateWorkflowReceiptStructure({
      ...doctor,
      evidence: [{ ...doctor.evidence[0], dbStatus: "missing" }],
    }).ok).toBe(false);

    const badInit = {
      schemaVersion: 1,
      activity: "setup",
      phase: "complete",
      outcome: "persisted",
      visibility: "brief",
      trigger: "init",
      evidence: [{
        source: "init_runtime_result",
        effect: "write",
        outcome: "persisted",
        subject: "/repo",
        ok: true,
        repoId: 7,
        schemaVersion: 14,
        conflictCount: 1,
      }],
      nextAction: null,
      at,
    };
    expect(validateWorkflowReceiptStructure(badInit).ok).toBe(false);

    const queued = projectInjectionInterventionReceipt({
      trigger: "inject",
      intervention: { kind: "inject", taskId: "task-auth", text: "x" },
      result: {
        requestId: "inject-1",
        outcome: "applied",
        injectionIds: [41],
        affectedTaskIds: ["task-auth"],
        acceptedAt: at,
      },
    });
    expect(validateWorkflowReceiptStructure({
      ...queued,
      evidence: [{ ...queued.evidence[0], injectionIds: [41, 42] }],
    }).ok).toBe(false);
  });
});

describe("checkpoint receipt projection", () => {
  const facts = (
    status: CheckpointCadenceFacts["status"],
    over: Partial<CheckpointCadenceFacts> = {},
  ): CheckpointCadenceFacts => ({
    status, countedTurns: 8, turnsSinceLastWrite: 8, threshold: 8, ...over,
  });

  it("projects a fired checkpoint as brief execute/attempted with turn evidence", () => {
    const receipt = projectCheckpointReceipt({
      trigger: "Cadence threshold reached on UserPromptSubmit.",
      taskId: "task:abc",
      facts: facts("fired"),
      at,
    });
    expect(validateWorkflowReceiptStructure(receipt)).toEqual({ ok: true });
    expect(receipt).toMatchObject({
      activity: "checkpoint",
      phase: "execute",
      outcome: "attempted",
      visibility: "brief",
      nextAction: null,
      evidence: [{
        source: "checkpoint_hook",
        effect: "none",
        outcome: "attempted",
        subject: "knowledge checkpoint for task task:abc",
        userTurnCount: 8,
        detail: "8 turns counted; threshold 8",
      }],
    });
    const text = renderWorkflowReceiptText(receipt);
    expect(text).toContain("turns=8");
    for (const label of ["Activity:", "Trigger:", "Effects:", "Result:", "Next:"]) {
      expect(text).toContain(label);
    }
  });

  it("projects a deferred checkpoint as prepare/skipped that yielded to delivery", () => {
    const receipt = projectCheckpointReceipt({
      trigger: "Cadence threshold reached while delivering interventions.",
      taskId: "task:abc",
      facts: facts("deferred", { turnsSinceLastWrite: 5 }),
      at,
    });
    expect(validateWorkflowReceiptStructure(receipt)).toEqual({ ok: true });
    expect(receipt).toMatchObject({ phase: "prepare", outcome: "skipped", visibility: "brief" });
    expect(receipt.evidence[0]).toMatchObject({
      outcome: "skipped",
      userTurnCount: 5,
      detail: "yielded to intervention delivery; threshold 8",
    });
  });

  it("refuses to project below-threshold heartbeats", () => {
    for (const status of ["counted", "duplicate"] as const) {
      expect(() => projectCheckpointReceipt({
        trigger: "tick", taskId: "task:abc", facts: facts(status), at,
      })).toThrow(/below-threshold/);
    }
  });

  it("rejects hand-built checkpoint evidence that violates the safety matrix", () => {
    const receipt = projectCheckpointReceipt({
      trigger: "Cadence threshold reached.", taskId: "task:abc", facts: facts("fired"), at,
    });
    const negativeTurns = {
      ...receipt,
      evidence: [{ ...receipt.evidence[0]!, userTurnCount: -1 }],
    };
    expect(validateWorkflowReceiptStructure(negativeTurns).ok).toBe(false);
    const wrongEffect = {
      ...receipt,
      evidence: [{ ...receipt.evidence[0]!, effect: "read" }],
    };
    expect(validateWorkflowReceiptStructure(wrongEffect).ok).toBe(false);
    const upgradedOutcome = {
      ...receipt,
      outcome: "persisted",
      evidence: [{ ...receipt.evidence[0]!, outcome: "persisted" }],
    };
    expect(validateWorkflowReceiptStructure(upgradedOutcome).ok).toBe(false);
  });
});

describe("bounded plain renderer and browser-safe contract", () => {
  it("sanitizes ANSI/control text, hard-wraps long tokens, and preserves CJK/emoji", () => {
    const receipt = projectOperationReceipt({
      trigger: "\u001b[31m为什么\u001b[0m\u0000 now 🚀",
      result: success("kb.spec.search", { items: ["one"], total: 1 }),
      nextAction: { required: false, instruction: "继续开发 🚀" },
    });
    const text = renderWorkflowReceiptText(receipt, { width: 24 });
    expect(text).not.toMatch(/\u001b|\u0000/);
    expect(text).toContain("为什么");
    expect(text).toContain("继续开发 🚀");
    expect(Math.max(...text.split("\n").map((line) => [...line].length))).toBeLessThanOrEqual(24);
    expect(text.length).toBeLessThanOrEqual(8_192);
  });

  it("clamps NaN/Infinity widths and rejects huge receipt fields instead of printing them", () => {
    const receipt = projectOperationReceipt({
      trigger: "query context",
      result: success("kb.spec.search", []),
    });
    for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const text = renderWorkflowReceiptText(receipt, { width });
      expect(text.length).toBeLessThanOrEqual(8_192);
    }
    expect(validateWorkflowReceiptStructure({
      ...receipt,
      trigger: "x".repeat(20_001),
    }).ok).toBe(false);
  });

  it("keeps the contracts source dependency-free and browser-safe", () => {
    const source = fs.readFileSync(new URL("../src/contract/workflow-receipt.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bimport\b|require\s*\(/);
    expect(source).not.toMatch(/node:|better-sqlite3|runtime-lifecycle|operation-dispatcher/);
  });

  it("keeps the injection projection inside the browser-safe contract layer", async () => {
    const source = fs.readFileSync(
      new URL("../src/contract/workflow-receipt-projection.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/node:|better-sqlite3|runtime-lifecycle|operation-dispatcher|activity-store/);
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier!.startsWith("./"))).toBe(true);
    const contracts = await import("../src/contract/index.js");
    const projectors = await import("../src/workflow-receipt-projectors.js");
    expect(projectors.projectInjectionInterventionReceipt)
      .toBe(contracts.projectInjectionInterventionReceipt);
  });

  it("retains all five sections and an omission marker under maximal effects at width 20", () => {
    const receipt = projectOperationReceipt({
      trigger: "x".repeat(20_000),
      result: success("kb.spec.search", { items: [], total: 0 }),
      nextAction: { required: true, instruction: "n".repeat(20_000) },
    });
    receipt.evidence = Array.from({ length: 32 }, (_, index) => ({
      ...receipt.evidence[0]!,
      requestId: `request-${index}`,
      subject: `kb.spec.search request request-${index}`,
      detail: "d".repeat(20_000),
    }));
    const text = renderWorkflowReceiptText(receipt, { width: 20 });
    for (const label of ["Activity:", "Trigger:", "Effects:", "Result:", "Next:"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("[effects omitted]");
    expect([...text].length).toBeLessThanOrEqual(8_192);
  });

  it("wraps by terminal display columns for CJK, emoji, and combining marks", () => {
    const receipt = projectOperationReceipt({
      trigger: "中文中文 🧠🧠 e\u0301e\u0301",
      result: success("kb.spec.search", []),
    });
    const text = renderWorkflowReceiptText(receipt, { width: 20 });
    expect(Math.max(...text.split("\n").map(terminalColumns))).toBeLessThanOrEqual(20);
  });
});

function terminalColumns(value: string): number {
  let columns = 0;
  for (const char of value) {
    if (/\p{Mark}/u.test(char) || char === "\u200d" || char === "\ufe0f") continue;
    if (/\p{Extended_Pictographic}/u.test(char) || /[\u2e80-\u9fff\uf900-\ufaff]/u.test(char)) columns += 2;
    else columns += 1;
  }
  return columns;
}
