import process from "node:process";
import type { Readable, Writable } from "node:stream";
import {
  deserializeMessage,
  serializeMessage,
} from "@modelcontextprotocol/sdk/shared/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import {
  OPERATION_INPUT_BYTE_LIMITS,
} from "@vw-ai/vibehub-core";

/** Raw UTF-8 bytes in one JSON-RPC line, excluding LF and including CR. */
export const MCP_STDIO_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Tight operation budgets reserve one MiB for the JSON-RPC/tool envelope.
 * Logical input budgets remain owned by Core's canonical operation contract.
 */
export const MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;

/** Retained as the named production wire limit for proposal submissions. */
export const MCP_STDIO_TICKET_PROPOSAL_MAX_MESSAGE_BYTES =
  OPERATION_INPUT_BYTE_LIMITS["ticket.proposal.submit"]
  + MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES;

export interface BoundedStdioServerTransportOptions {
  maximumMessageBytes?: number;
  operationInputByteLimits?: Readonly<Record<string, number>>;
  operationEnvelopeAllowanceBytes?: number;
}

const FRAME_SLAB_BYTES = 64 * 1024;
interface OperationWireBudget {
  maximumInputBytes: number;
  maximumMessageBytes: number;
}

/**
 * Newline-delimited MCP transport with bounded-slab framing and finite memory.
 *
 * The upstream SDK transport repeatedly concatenates partial chunks before it
 * sees LF. This reader copies arbitrary trickle chunks into fixed-size slabs,
 * bounding both payload bytes and Buffer metadata, then concatenates at most
 * once per multi-slab frame.
 */
export class BoundedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  onfatal?: (error: Error) => void;

  private readonly maximumMessageBytes: number;
  private readonly operationWireBudgets =
    new Map<string, OperationWireBudget>();
  private readonly slabs: Buffer[] = [];
  private currentSlabBytes = 0;
  private messageBytes = 0;
  private pendingWrites = 0;
  private started = false;
  private closed = false;
  private closeNotified = false;
  private fatalNotified = false;
  private closePromise?: Promise<void>;
  private outputDetachPromise?: Promise<void>;

  constructor(
    private readonly stdin: Readable = process.stdin,
    private readonly stdout: Writable = process.stdout,
    options: BoundedStdioServerTransportOptions = {},
  ) {
    this.maximumMessageBytes =
      options.maximumMessageBytes ?? MCP_STDIO_MAX_MESSAGE_BYTES;
    assertPositiveSafeInteger(
      this.maximumMessageBytes,
      "maximumMessageBytes",
    );
    const envelopeAllowanceBytes =
      options.operationEnvelopeAllowanceBytes
      ?? MCP_STDIO_OPERATION_ENVELOPE_ALLOWANCE_BYTES;
    assertNonnegativeSafeInteger(
      envelopeAllowanceBytes,
      "operationEnvelopeAllowanceBytes",
    );
    const inputByteLimits =
      options.operationInputByteLimits ?? OPERATION_INPUT_BYTE_LIMITS;
    for (const [operation, maximumInputBytes] of Object.entries(
      inputByteLimits,
    )) {
      assertPositiveSafeInteger(
        maximumInputBytes,
        `operationInputByteLimits[${JSON.stringify(operation)}]`,
      );
      const maximumOperationMessageBytes =
        maximumInputBytes + envelopeAllowanceBytes;
      if (!Number.isSafeInteger(maximumOperationMessageBytes)) {
        throw new Error(
          `wire budget for ${operation} must be a safe integer`,
        );
      }
      if (maximumOperationMessageBytes > this.maximumMessageBytes) {
        throw new Error(
          `wire budget for ${operation} must not exceed maximumMessageBytes`,
        );
      }
      this.operationWireBudgets.set(operation, {
        maximumInputBytes,
        maximumMessageBytes: maximumOperationMessageBytes,
      });
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("BoundedStdioServerTransport already started");
    }
    if (this.closed) {
      throw new Error("BoundedStdioServerTransport is closed");
    }
    this.started = true;
    this.stdin.on("data", this.handleData);
    this.stdin.on("error", this.handleInputError);
    this.stdin.on("end", this.handleEnd);
    this.stdout.on("error", this.handleOutputError);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    if (!this.closed) {
      this.closed = true;
      this.detachInput();
      this.clearFrame();
      if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    }
    this.notifyClose();
    if (this.pendingWrites === 0) void this.scheduleOutputDetach();
    // Protocol shutdown must not hang on a backpressured peer. Outstanding
    // writes keep the stdout error guard until their callbacks eventually
    // settle, but they do not delay close or SIGTERM.
    this.closePromise = Promise.resolve();
    return this.closePromise;
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("BoundedStdioServerTransport is closed");
    }
    const serialized = serializeMessage(message);
    this.pendingWrites += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error | null): void => {
          if (settled) return;
          settled = true;
          if (error) {
            this.failFatal(error);
            reject(error);
          } else {
            resolve();
          }
        };
        try {
          this.stdout.write(serialized, settle);
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
        }
      });
    } finally {
      this.pendingWrites -= 1;
      if (this.pendingWrites === 0) {
        if (this.closed) void this.scheduleOutputDetach();
      }
    }
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(start, end);
      if (!this.appendSegment(segment)) return;
      if (newline === -1) return;
      this.processFrame();
      if (this.closed) return;
      start = newline + 1;
    }
  };

  private readonly handleInputError = (error: Error): void => {
    this.failFatal(error);
  };

  private readonly handleOutputError = (error: Error): void => {
    this.failFatal(error);
  };

  private readonly handleEnd = (): void => {
    if (this.messageBytes > 0) {
      this.failFatal(new Error(
        "MCP stdio ended with an incomplete JSON-RPC message",
      ));
      return;
    }
    void this.close();
  };

  private appendSegment(segment: Buffer): boolean {
    if (this.messageBytes + segment.length > this.maximumMessageBytes) {
      this.failFatal(new Error(
        `MCP stdio message exceeds ${this.maximumMessageBytes} bytes`,
      ));
      return false;
    }
    let sourceOffset = 0;
    while (sourceOffset < segment.length) {
      let slab = this.slabs.at(-1);
      if (slab === undefined || this.currentSlabBytes === slab.length) {
        slab = Buffer.allocUnsafe(
          Math.min(FRAME_SLAB_BYTES, this.maximumMessageBytes),
        );
        this.slabs.push(slab);
        this.currentSlabBytes = 0;
      }
      const byteCount = Math.min(
        segment.length - sourceOffset,
        slab.length - this.currentSlabBytes,
      );
      segment.copy(
        slab,
        this.currentSlabBytes,
        sourceOffset,
        sourceOffset + byteCount,
      );
      this.currentSlabBytes += byteCount;
      this.messageBytes += byteCount;
      sourceOffset += byteCount;
    }
    return true;
  }

  private processFrame(): void {
    const rawBytes = this.messageBytes;
    const frame = this.slabs.length === 0
      ? Buffer.alloc(0)
      : this.slabs.length === 1
        ? this.slabs[0]!.subarray(0, this.currentSlabBytes)
        : Buffer.concat(
            this.slabs.map((slab, index) =>
              index === this.slabs.length - 1
                ? slab.subarray(0, this.currentSlabBytes)
                : slab),
            rawBytes,
          );
    this.clearFrame();

    let message: JSONRPCMessage;
    try {
      const line = frame.toString("utf8").replace(/\r$/, "");
      message = deserializeMessage(line);
    } catch (error) {
      this.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return;
    }

    const ticketOperation = getTicketOperationName(message);
    if (ticketOperation !== undefined) {
      const budget = this.operationWireBudgets.get(ticketOperation);
      if (budget !== undefined && rawBytes > budget.maximumMessageBytes) {
        this.rejectOversizedTicketOperation(message, ticketOperation, budget);
        return;
      }
    }
    this.onmessage?.(message);
  }

  private rejectOversizedTicketOperation(
    message: JSONRPCMessage,
    operation: string,
    budget: OperationWireBudget,
  ): void {
    const id = "id" in message ? message.id : undefined;
    if (typeof id !== "string" && typeof id !== "number") return;
    const response: JSONRPCErrorResponse = {
      jsonrpc: "2.0",
      id,
      error: {
        code: ErrorCode.InvalidParams,
        message: "Ticket operation MCP message is too large",
        data: {
          code: "ticket_operation_message_too_large",
          operation,
          maximumMessageBytes: budget.maximumMessageBytes,
          maximumInputBytes: budget.maximumInputBytes,
        },
      },
    };
    void this.send(response).catch((error: unknown) => {
      this.failFatal(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  private failFatal(error: Error): void {
    if (this.fatalNotified) return;
    this.fatalNotified = true;
    if (!this.closed) {
      this.closed = true;
      this.detachInput();
      this.clearFrame();
      if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    }
    if (this.pendingWrites === 0) void this.scheduleOutputDetach();
    this.onerror?.(error);
    this.onfatal?.(error);
    this.notifyClose();
  }

  private detachInput(): void {
    this.stdin.off("data", this.handleData);
    this.stdin.off("error", this.handleInputError);
    this.stdin.off("end", this.handleEnd);
  }

  private detachOutput(): void {
    this.stdout.off("error", this.handleOutputError);
  }

  private scheduleOutputDetach(): Promise<void> {
    if (!this.closed || this.pendingWrites !== 0) return Promise.resolve();
    if (this.outputDetachPromise !== undefined) {
      return this.outputDetachPromise;
    }
    this.outputDetachPromise = new Promise((resolve) => {
      // Writable invokes the write callback before emitting its matching
      // `error`. Keep the listener through the following event-loop turn.
      setImmediate(() => {
        if (this.closed && this.pendingWrites === 0) this.detachOutput();
        resolve();
      });
    });
    return this.outputDetachPromise;
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    this.onclose?.();
  }

  private clearFrame(): void {
    this.slabs.length = 0;
    this.currentSlabBytes = 0;
    this.messageBytes = 0;
  }
}

function getTicketOperationName(
  message: JSONRPCMessage,
): string | undefined {
  if (!("method" in message) || message.method !== "tools/call") {
    return undefined;
  }
  const params = message.params as {
    name?: unknown;
    arguments?: {
      operation?: unknown;
    };
  } | undefined;
  const operation = params?.arguments?.operation;
  return params?.name === "ticket_operation" && typeof operation === "string"
    ? operation
    : undefined;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (Number.isSafeInteger(value) && value > 0) return;
  throw new Error(`${name} must be a positive safe integer`);
}

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (Number.isSafeInteger(value) && value >= 0) return;
  throw new Error(`${name} must be a nonnegative safe integer`);
}
