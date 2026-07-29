import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isJsonValueWithinByteBudgetV0,
  isTicketProposalInputWithinBudgetV0,
  OPERATION_INPUT_BYTE_LIMITS,
  operationInputSchemas,
  TICKET_PROPOSAL_MAX_INPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES,
} from "@vw-ai/vibehub-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const validatorPath = path.join(
  root,
  "skills/scripts/operation-contract-validator.mjs",
);

describe("packaged operation contract byte budget", () => {
  it("derives the Skill adapter limit from the Core contract", async () => {
    const generatedLimits = await import(
      path.join(root, "skills/scripts/generated-operation-limits.mjs")
    ) as {
      OPERATION_INPUT_BYTE_LIMITS: Record<string, number>;
      TICKET_PROPOSAL_MAX_INPUT_BYTES: number;
      TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES: number;
    };
    const artifact = JSON.parse(fs.readFileSync(
      path.join(root, "skills/contracts/operation-contracts.json"),
      "utf8",
    ));
    const byteBudget = artifact.operations[
      "ticket.proposal.submit"
    ].runtimeRefinements.find(
      (rule: { kind: string }) => rule.kind === "maxJsonBytes",
    );

    expect(generatedLimits.TICKET_PROPOSAL_MAX_INPUT_BYTES)
      .toBe(TICKET_PROPOSAL_MAX_INPUT_BYTES);
    expect(generatedLimits.TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES)
      .toBe(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES);
    expect(generatedLimits.OPERATION_INPUT_BYTE_LIMITS)
      .toEqual(OPERATION_INPUT_BYTE_LIMITS);
    expect(byteBudget.maximum).toBe(TICKET_PROPOSAL_MAX_INPUT_BYTES);
  });

  it("counts exact escaped JSON bytes and exits before later properties", async () => {
    const { isJsonWithinByteBudget } = await import(
      validatorPath
    ) as {
      isJsonWithinByteBudget(value: unknown, maximum: number): boolean;
    };
    const maximum = 4 * 1024 * 1024;
    const exactEscapedString = "\"".repeat((maximum - 4) / 2);
    expect(isJsonWithinByteBudget([exactEscapedString], maximum)).toBe(true);
    expect(isJsonWithinByteBudget([`${exactEscapedString}"`], maximum)).toBe(false);

    let readPastBudget = false;
    const value: Record<string, unknown> = {
      payload: "x".repeat(maximum),
    };
    Object.defineProperty(value, "mustNotRead", {
      enumerable: true,
      get() {
        readPastBudget = true;
        throw new Error("budget traversal continued");
      },
    });
    expect(isJsonWithinByteBudget(value, maximum)).toBe(false);
    expect(readPastBudget).toBe(false);
  });

  it("keeps Core and packaged counters aligned with JSON UTF-8 bytes", async () => {
    const { isJsonWithinByteBudget } = await import(validatorPath) as {
      isJsonWithinByteBudget(value: unknown, maximum: number): boolean;
    };
    const maximum = TICKET_PROPOSAL_MAX_INPUT_BYTES;
    const corpus: unknown[] = [
      null,
      true,
      false,
      0,
      -12.5,
      { "\"\n😀\ud800": ["\u0000", "é", { nested: "value" }] },
      [{ a: 1 }, ["b", null, false]],
      ["x".repeat(maximum - 4)],
      [`${"x".repeat(maximum - 4)}x`],
      ["😀".repeat((maximum - 4) / 4)],
      [`${"😀".repeat((maximum - 4) / 4)}x`],
      ["\u0000".repeat((maximum - 4) / 6)],
      [`${"\u0000".repeat((maximum - 4) / 6)}x`],
      ["\ud800".repeat((maximum - 4) / 6)],
      [`${"\ud800".repeat((maximum - 4) / 6)}x`],
    ];

    for (const value of corpus) {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new Error("expected JSON corpus value");
      const expected = Buffer.byteLength(serialized, "utf8") <= maximum;
      expect(
        isTicketProposalInputWithinBudgetV0(value),
        serialized.slice(0, 80),
      ).toBe(expected);
      expect(
        isJsonValueWithinByteBudgetV0(value, maximum),
        serialized.slice(0, 80),
      ).toBe(expected);
      expect(
        isJsonWithinByteBudget(value, maximum),
        serialized.slice(0, 80),
      ).toBe(expected);
    }
  });

  it("runs maxJsonBytes before JSON Schema traversal and only once", async () => {
    const { validateOperationContract } = await import(validatorPath) as {
      validateOperationContract(
        contract: unknown,
        value: unknown,
      ): { valid: boolean; errors: Array<{ refinementId?: string }> };
    };
    let budgetPropertyReads = 0;
    let schemaPropertyRead = false;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "payload", {
      enumerable: true,
      get() {
        budgetPropertyReads += 1;
        return "x".repeat(256);
      },
    });
    Object.defineProperty(value, "schemaProperty", {
      enumerable: true,
      get() {
        schemaPropertyRead = true;
        throw new Error("schema traversal ran before byte budget");
      },
    });
    const result = validateOperationContract({
      input: {
        type: "object",
        properties: {
          payload: { type: "string" },
          schemaProperty: { type: "string" },
        },
      },
      runtimeRefinements: [{
        id: "early-budget",
        kind: "maxJsonBytes",
        maximum: 32,
        message: "over budget",
      }],
    }, value);
    expect(result).toEqual({
      valid: false,
      errors: [{
        path: "$",
        message: "over budget",
        refinementId: "early-budget",
      }],
    });
    expect(budgetPropertyReads).toBe(1);
    expect(schemaPropertyRead).toBe(false);
  });

  it("materializes compact generated fixtures and raw-guards before JSON.parse", async () => {
    const {
      materializeOperationFixture,
      validateOperationContract,
    } = await import(validatorPath) as {
      materializeOperationFixture(contract: unknown, fixture: unknown): unknown;
      validateOperationContract(
        contract: unknown,
        value: unknown,
      ): { valid: boolean; errors: Array<{ refinementId?: string }> };
    };
    const artifact = JSON.parse(fs.readFileSync(
      path.join(root, "skills/contracts/operation-contracts.json"),
      "utf8",
    ));
    const contract = artifact.operations["ticket.proposal.submit"];
    const fixture = contract.fixtures.negatives.find(
      (candidate: { case: string }) =>
        candidate.case === "proposal aggregate JSON byte budget",
    );
    expect(fixture).not.toHaveProperty("value");
    const materialized = materializeOperationFixture(contract, fixture);
    expect(validateOperationContract(contract, materialized)).toMatchObject({
      valid: false,
      errors: [{ refinementId: "ticket-proposal-input-byte-budget" }],
    });

    const run = spawnSync(process.execPath, [
      path.join(root, "skills/scripts/validate-artifact.mjs"),
      "--operation",
      "ticket.proposal.submit",
    ], {
      input: " ".repeat(4 * 1024 * 1024 + 1),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      valid: false,
      errors: [{
        path: "$",
        message: "raw JSON input exceeds 4194304 bytes",
        refinementId: "ticket-proposal-input-byte-budget",
      }],
    });

    const validationContract = artifact.operations[
      "ticket.proposal.validation.record"
    ];
    const validationFixture = validationContract.fixtures.negatives.find(
      (candidate: { case: string }) =>
        candidate.case === "proposal validation aggregate JSON byte budget",
    );
    expect(validationFixture).not.toHaveProperty("value");
    const materializedValidation = materializeOperationFixture(
      validationContract,
      validationFixture,
    );
    expect(Buffer.byteLength(JSON.stringify(materializedValidation), "utf8"))
      .toBeGreaterThan(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES);
    expect(validateOperationContract(
      validationContract,
      materializedValidation,
    )).toMatchObject({
      valid: false,
      errors: [{
        refinementId: "ticket-proposal-validation-input-byte-budget",
      }],
    });

    const rawValidation = spawnSync(process.execPath, [
      path.join(root, "skills/scripts/validate-artifact.mjs"),
      "--operation",
      "ticket.proposal.validation.record",
    ], {
      input: " ".repeat(TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES + 1),
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    expect(rawValidation.status, rawValidation.stdout + rawValidation.stderr)
      .toBe(2);
    expect(JSON.parse(rawValidation.stdout)).toMatchObject({
      valid: false,
      errors: [{
        path: "$",
        message: "raw JSON input exceeds 1048576 bytes",
        refinementId: "ticket-proposal-validation-input-byte-budget",
      }],
    });

    for (const operation of [
      "ticket.proposal.inspect",
      "ticket.proposal.list",
      "ticket.proposal.validation.inspect",
      "ticket.proposal.validation.list",
    ] as const) {
      const maximum = OPERATION_INPUT_BYTE_LIMITS[operation];
      const rawRead = spawnSync(process.execPath, [
        path.join(root, "skills/scripts/validate-artifact.mjs"),
        "--operation",
        operation,
      ], {
        input: " ".repeat(maximum + 1),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      expect(rawRead.status, rawRead.stdout + rawRead.stderr).toBe(2);
      expect(JSON.parse(rawRead.stdout)).toMatchObject({
        valid: false,
        errors: [{
          path: "$",
          message: `raw JSON input exceeds ${maximum} bytes`,
          refinementId: "operation-input-byte-budget",
        }],
      });
    }
  });

  it("freezes every validation subject branch and keeps apply absent", async () => {
    const { validateOperationContract } = await import(validatorPath) as {
      validateOperationContract(
        contract: unknown,
        value: unknown,
      ): { valid: boolean; errors: unknown[] };
    };
    const artifact = JSON.parse(fs.readFileSync(
      path.join(root, "skills/contracts/operation-contracts.json"),
      "utf8",
    ));
    const operationNames = Object.keys(artifact.operations);
    expect(operationNames).not.toContain("ticket.proposal.apply");
    expect(Object.keys(operationInputSchemas))
      .not.toContain("ticket.proposal.apply");

    const contract = artifact.operations[
      "ticket.proposal.validation.record"
    ];
    const ticketSubject = structuredClone(contract.fixtures.positive);
    ticketSubject.checks[0].subject = {
      kind: "ticket_change",
      ticketId: "TKT-1",
      definitionRevision: 1,
    };
    expect(validateOperationContract(contract, ticketSubject))
      .toEqual({ valid: true, errors: [] });

    for (const change of ["added", "removed"] as const) {
      const dependencySubject = structuredClone(contract.fixtures.positive);
      dependencySubject.checks[2].subject = {
        kind: "dependency_change",
        change,
        prerequisiteTicketId: "TKT-1",
        dependentTicketId: "TKT-2",
      };
      expect(validateOperationContract(contract, dependencySubject))
        .toEqual({ valid: true, errors: [] });
    }
  });
});
