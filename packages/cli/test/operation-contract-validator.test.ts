import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPERATION_INPUT_BYTE_LIMITS,
  operationInputSchemas,
} from "@vw-ai/vibehub-core";
import { describe, expect, it } from "vitest";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const validatorPath = path.join(
  root,
  "skills/scripts/operation-contract-validator.mjs",
);
const contractsPath = path.join(
  root,
  "skills/contracts/operation-contracts.json",
);

describe("packaged operation contract validation", () => {
  it("derives the Skill adapter limits from the current Core registry", async () => {
    const generatedLimits = await import(
      path.join(root, "skills/scripts/generated-operation-limits.mjs")
    ) as Record<string, unknown>;
    expect(generatedLimits.OPERATION_INPUT_BYTE_LIMITS)
      .toEqual(OPERATION_INPUT_BYTE_LIMITS);
    expect(generatedLimits).not.toHaveProperty(
      "TICKET_PROPOSAL_MAX_INPUT_BYTES",
    );
    expect(generatedLimits).not.toHaveProperty(
      "TICKET_PROPOSAL_VALIDATION_MAX_INPUT_BYTES",
    );
  });

  it("counts exact escaped JSON bytes and exits before later properties", async () => {
    const { isJsonWithinByteBudget } = await import(
      validatorPath
    ) as {
      isJsonWithinByteBudget(value: unknown, maximum: number): boolean;
    };
    const maximum = 4 * 1024;
    const exactEscapedString = "\"".repeat((maximum - 4) / 2);
    expect(isJsonWithinByteBudget([exactEscapedString], maximum)).toBe(true);
    expect(isJsonWithinByteBudget(
      [`${exactEscapedString}"`],
      maximum,
    )).toBe(false);

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

  it("publishes only the canonical Git-native Ticket contracts", async () => {
    const { validateOperationContract } = await import(validatorPath) as {
      validateOperationContract(
        contract: unknown,
        value: unknown,
      ): { valid: boolean; errors: unknown[] };
    };
    const artifact = JSON.parse(fs.readFileSync(contractsPath, "utf8"));
    const ticketOperations = Object.keys(artifact.operations)
      .filter((operation) => operation.startsWith("ticket."));
    expect(ticketOperations).toEqual([
      "ticket.decision.record",
      "ticket.graph.snapshot",
      "ticket.review.append",
      "ticket.subject.inspect",
      "ticket.trace.list",
      "ticket.worktree.patch",
    ]);
    expect(ticketOperations).toEqual(
      Object.keys(operationInputSchemas)
        .filter((operation) => operation.startsWith("ticket."))
        .sort(),
    );
    for (const operation of ticketOperations) {
      const contract = artifact.operations[operation];
      expect(validateOperationContract(
        contract,
        contract.fixtures.positive,
      )).toEqual({ valid: true, errors: [] });
      for (const negative of contract.fixtures.negatives) {
        expect(validateOperationContract(contract, negative.value).valid)
          .toBe(false);
      }
    }
    const patchNegativeCases = artifact.operations[
      "ticket.worktree.patch"
    ].fixtures.negatives.map((fixture: { case: string }) => fixture.case);
    expect(patchNegativeCases).toEqual(expect.arrayContaining([
      "patch put requires a complete Ticket document",
      "patch Ticket document is closed",
      "patch Ticket key must match document ID",
    ]));
    expect(artifact.operations["ticket.review.append"].fixtures.negatives)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ case: "review type is closed" }),
      ]));
    expect(artifact.operations["ticket.decision.record"].fixtures.negatives)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          case: "plan approval rejects delegated boundaries",
        }),
      ]));
    expect(JSON.stringify(artifact)).not.toMatch(/ticket\.proposal/);
  });

  it("rejects retired Ticket operations at the packaged validator boundary", () => {
    const run = spawnSync(process.execPath, [
      path.join(root, "skills/scripts/validate-artifact.mjs"),
      "--operation",
      "ticket.proposal.submit",
    ], {
      input: "{}",
      encoding: "utf8",
    });
    expect(run.status, run.stdout + run.stderr).toBe(2);
    expect(JSON.parse(run.stdout)).toMatchObject({
      valid: false,
      errors: [expect.objectContaining({
        message: expect.stringMatching(/unknown operation/i),
      })],
    });
  });
});
