import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TicketLedgerError } from "../src/ticket-ledger/contract.js";
import { readTicketLedgerFileBounded } from "../src/ticket-ledger/file-io.js";

describe("Ticket ledger bounded file reads", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stops after the one-byte overflow sentinel", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-ticket-file-io-"),
    );
    roots.push(root);
    const filePath = path.join(root, "growing.yaml");
    fs.writeFileSync(filePath, Buffer.alloc(8_192, 0x78));
    const descriptor = fs.openSync(filePath, "r");
    try {
      try {
        readTicketLedgerFileBounded(
          descriptor,
          ".vibehub/tickets/tickets/growing.yaml",
          4_096,
        );
        throw new Error("expected a bounded-read failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TicketLedgerError);
        expect(error).toMatchObject({
          code: "file_too_large",
          details: expect.objectContaining({ byteLength: 4_097 }),
        });
      }
    } finally {
      fs.closeSync(descriptor);
    }
  });
});
