import { PassThrough, Writable } from "node:stream";
import { OPERATION_INPUT_BYTE_LIMITS } from "@vw-ai/vibehub-core";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedStdioServerTransport,
  MCP_STDIO_MAX_MESSAGE_BYTES,
  MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES,
  MCP_STDIO_TICKET_PROPOSAL_MAX_MESSAGE_BYTES,
} from "../src/bounded-stdio.js";

const ping = (id: number) => JSON.stringify({
  jsonrpc: "2.0",
  id,
  method: "ping",
});

describe("BoundedStdioServerTransport", () => {
  it("preserves complete, split, and coalesced frames", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: 128,
      operationInputByteLimits: {},
    });
    const messages: unknown[] = [];
    transport.onmessage = (message) => messages.push(message);
    await transport.start();

    input.write(ping(1).slice(0, 8));
    input.write(`${ping(1).slice(8)}\n${ping(2)}\r\n`);

    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const closed = vi.fn();
    transport.onclose = closed;
    await transport.close();
    await transport.close();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("counts raw UTF-8 bytes and fails before an unbounded frame can grow", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: 4,
      operationInputByteLimits: {},
    });
    const fatal = vi.fn();
    const delivered = vi.fn();
    transport.onfatal = fatal;
    transport.onmessage = delivered;
    await transport.start();

    input.write("😀");
    expect(fatal).not.toHaveBeenCalled();
    input.write("x");

    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "MCP stdio message exceeds 4 bytes",
      }),
    );
    expect(delivered).not.toHaveBeenCalled();
  });

  it("coalesces byte-at-a-time trickle input into bounded slabs", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: 128 * 1024,
      operationInputByteLimits: {},
    });
    await transport.start();

    for (let index = 0; index < 10_000; index += 1) input.write("x");

    expect((transport as unknown as { slabs: Buffer[] }).slabs).toHaveLength(1);
    await transport.close();
  });

  it("rejects budgeted Ticket operations at their operation-specific wire limits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let rawOutput = "";
    output.on("data", (chunk: Buffer) => {
      rawOutput += chunk.toString("utf8");
    });
    const operations = [
      {
        id: "proposal-1",
        operation: "ticket.proposal.submit",
      },
      {
        id: "validation-1",
        operation: "ticket.proposal.validation.record",
      },
    ];
    const requests = operations.map(({ id, operation }) => JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "ticket_operation",
        arguments: {
          operation,
          input: {},
        },
      },
    }));
    const allowance = 16;
    const inputLimits = Object.fromEntries(
      operations.map(({ operation }, index) => [
        operation,
        Buffer.byteLength(requests[index]!) - allowance - 1,
      ]),
    );
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: Math.max(
        ...requests.map((request) => Buffer.byteLength(request)),
      ),
      operationInputByteLimits: inputLimits,
      operationEnvelopeAllowanceBytes: allowance,
    });
    const delivered = vi.fn();
    transport.onmessage = delivered;
    await transport.start();

    input.write(`${requests.join("\n")}\n`);

    expect(delivered).not.toHaveBeenCalled();
    expect(rawOutput.trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual(operations.map(({ id, operation }, index) => ({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: "Ticket operation MCP message is too large",
          data: {
            code: "ticket_operation_message_too_large",
            operation,
            maximumMessageBytes: Buffer.byteLength(requests[index]!) - 1,
            maximumInputBytes: inputLimits[operation],
          },
        },
      })));
    await transport.close();
  });

  it("does not apply Ticket operation budgets to other operation families", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "distill_operation",
        arguments: {
          operation: "distill.inventory.put",
          input: { padding: "x".repeat(80) },
        },
      },
    });
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: request.length,
      operationInputByteLimits: {
        "ticket.proposal.submit": 64,
      },
      operationEnvelopeAllowanceBytes: 0,
    });
    const delivered = vi.fn();
    transport.onmessage = delivered;
    await transport.start();

    input.write(`${request}\n`);

    expect(delivered).toHaveBeenCalledOnce();
    await transport.close();
  });

  it("delivers Ticket operations that have no configured tight budget", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ticket_operation",
        arguments: {
          operation: "ticket.graph.snapshot",
          input: { padding: "x".repeat(80) },
        },
      },
    });
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: request.length,
      operationInputByteLimits: {
        "ticket.proposal.submit": 64,
      },
      operationEnvelopeAllowanceBytes: 0,
    });
    const delivered = vi.fn();
    transport.onmessage = delivered;
    await transport.start();

    input.write(`${request}\n`);

    expect(delivered).toHaveBeenCalledOnce();
    await transport.close();
  });

  it("turns asynchronous stdout failures into fatal transport errors", async () => {
    const input = new PassThrough();
    const output = new class extends Writable {
      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        setImmediate(() => callback(new Error("EPIPE")));
      }
    }();
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: 128,
      operationInputByteLimits: {},
    });
    const fatal = vi.fn();
    transport.onfatal = fatal;
    await transport.start();

    await expect(transport.send({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    })).rejects.toThrow("EPIPE");
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "EPIPE" }),
    );
  });

  it("keeps stdout guarded until pending writes settle during close", async () => {
    const input = new PassThrough();
    let failWrite: ((error: Error) => void) | undefined;
    const output = new class extends Writable {
      override _write(
        _chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        failWrite = callback;
      }
    }();
    const transport = new BoundedStdioServerTransport(input, output, {
      maximumMessageBytes: 128,
      operationInputByteLimits: {},
    });
    const fatal = vi.fn();
    const closed = vi.fn();
    transport.onfatal = fatal;
    transport.onclose = closed;
    await transport.start();

    const sending = transport.send({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
    const rejectedSend = expect(sending).rejects.toThrow("late-EPIPE");
    await expect(transport.close()).resolves.toBeUndefined();
    expect(closed).toHaveBeenCalledOnce();
    expect(failWrite).toBeTypeOf("function");
    failWrite!(new Error("late-EPIPE"));

    await rejectedSend;
    expect(fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "late-EPIPE" }),
    );
    expect(closed).toHaveBeenCalledOnce();
    await expect(transport.send({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    })).rejects.toThrow("BoundedStdioServerTransport is closed");
  });

  it("publishes finite production limits and validates constructor overrides", () => {
    expect(MCP_STDIO_MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
    expect(MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES)
      .toBe(1024 * 1024);
    expect(MCP_STDIO_TICKET_PROPOSAL_MAX_MESSAGE_BYTES)
      .toBe(
        OPERATION_INPUT_BYTE_LIMITS["ticket.proposal.submit"]
        + MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES,
      );
    const production = new BoundedStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
    );
    const productionBudgets = (
      production as unknown as {
        operationWireBudgets: Map<string, {
          maximumInputBytes: number;
          maximumMessageBytes: number;
        }>;
      }
    ).operationWireBudgets;
    expect([...productionBudgets.keys()].sort()).toEqual(
      Object.keys(OPERATION_INPUT_BYTE_LIMITS).sort(),
    );
    expect(productionBudgets.get("ticket.proposal.validation.record"))
      .toEqual({
        maximumInputBytes:
          OPERATION_INPUT_BYTE_LIMITS["ticket.proposal.validation.record"],
        maximumMessageBytes:
          OPERATION_INPUT_BYTE_LIMITS["ticket.proposal.validation.record"]
          + MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES,
      });
    expect(() => new BoundedStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      { maximumMessageBytes: 0 },
    )).toThrow("maximumMessageBytes must be a positive safe integer");
    expect(() => new BoundedStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      {
        maximumMessageBytes: 8,
        operationInputByteLimits: {
          "ticket.proposal.validation.record": 9,
        },
        operationEnvelopeAllowanceBytes: 0,
      },
    )).toThrow(
      "wire budget for ticket.proposal.validation.record must not exceed maximumMessageBytes",
    );
    expect(() => new BoundedStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      {
        operationInputByteLimits: {
          "ticket.proposal.submit": 0,
        },
      },
    )).toThrow(
      "operationInputByteLimits[\"ticket.proposal.submit\"] must be a positive safe integer",
    );
    expect(() => new BoundedStdioServerTransport(
      new PassThrough(),
      new PassThrough(),
      { operationEnvelopeAllowanceBytes: -1 },
    )).toThrow(
      "operationEnvelopeAllowanceBytes must be a nonnegative safe integer",
    );
  });
});
