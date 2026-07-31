import fs from "node:fs";
import { TicketLedgerError } from "./contract.js";

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read at most maxBytes + 1 from an already verified regular-file descriptor.
 * The +1 sentinel closes the fstat/read race where another process grows the
 * file after the caller's size check.
 */
export const readTicketLedgerFileBounded = (
  descriptor: number,
  documentPath: string,
  maxBytes: number,
): Buffer => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const allowance = Math.min(
      READ_CHUNK_BYTES,
      maxBytes - totalBytes + 1,
    );
    const buffer = Buffer.allocUnsafe(allowance);
    const bytesRead = fs.readSync(
      descriptor,
      buffer,
      0,
      allowance,
      null,
    );
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) {
      throw new TicketLedgerError(
        "file_too_large",
        `${documentPath} exceeds its ${maxBytes}-byte limit`,
        { documentPath, byteLength: totalBytes, maxBytes },
      );
    }
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, totalBytes);
};
