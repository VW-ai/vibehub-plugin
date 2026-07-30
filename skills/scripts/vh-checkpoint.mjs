#!/usr/bin/env node
import fs from "node:fs";
import { captureCommand } from "./_capture.mjs";
import { resolveVibehubInvocation } from "./_dispatch.mjs";

const CHECKPOINT_INPUT_MAX_BYTES = 1024 * 1024;

function fail(message, code = "validation_error", exit = 2) {
  fs.writeSync(1, `${JSON.stringify({
    ok: false,
    error: { code, message, details: null, nextSafeActions: ["Correct the request and retry."] },
  })}\n`);
  process.exit(exit);
}

const argv = process.argv.slice(2);
const operation = argv.shift();
if (operation !== "prepare" && operation !== "commit") {
  fail(`unsupported checkpoint operation: ${operation ?? ""}`);
}

let inputPath = "-";
let scope = "semantic";
const forwarded = [];
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--input") {
    inputPath = argv[++index] ?? fail("--input needs a file or -");
  } else if (flag === "--scope") {
    scope = argv[++index] ?? fail("--scope needs semantic or ticket");
    if (scope !== "semantic" && scope !== "ticket") {
      fail("--scope needs semantic or ticket");
    }
    forwarded.push(flag, scope);
  } else if (["--repo", "--actor", "--task", "--request", "--protect"].includes(flag)) {
    const value = argv[++index];
    if (value === undefined) fail(`${flag} needs a value`);
    forwarded.push(flag, value);
  } else {
    fail(`unknown flag: ${flag}`);
  }
}

let input;
const needsInput = operation === "commit" || scope === "ticket";
if (needsInput) {
  try {
    input = readUtf8Bounded(inputPath, CHECKPOINT_INPUT_MAX_BYTES).trim();
    JSON.parse(input);
  } catch (error) {
    fail(`invalid checkpoint input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const invocation = resolveVibehubInvocation();
const child = await captureCommand(
  invocation.command,
  [
    ...invocation.prefix,
    "checkpoint",
    operation,
    "--json",
    ...forwarded,
    ...(needsInput ? ["--input", "-"] : []),
  ],
  { input, env: process.env },
);
if (child.kind === "overflow") fail(`vibehub CLI response exceeded ${child.limit} bytes`, "response_too_large", 1);
if (child.kind === "spawn_error") fail(`cannot execute vibehub CLI: ${child.error.message}`, "internal_error", 1);
if (child.kind === "signal") fail(`vibehub CLI terminated by signal ${child.signal}`, "cli_terminated", 1);
const output = child.stdout.trim();
try {
  JSON.parse(output);
} catch {
  const detail = diagnostic(child.stderr || child.stdout);
  fail(
    `vibehub CLI returned a non-JSON response${detail ? `: ${detail}` : ""}`,
    "internal_error",
    1,
  );
}
fs.writeSync(1, `${output}\n`);
process.exit(child.status);

function diagnostic(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 400);
}

function readUtf8Bounded(inputFile, maximumBytes) {
  const ownsDescriptor = inputFile !== "-";
  const descriptor = ownsDescriptor ? fs.openSync(inputFile, "r") : 0;
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const allowance = Math.min(
        64 * 1024,
        maximumBytes - totalBytes + 1,
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
      if (totalBytes > maximumBytes) {
        throw new Error(
          `checkpoint raw JSON input exceeds ${maximumBytes} bytes`,
        );
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    if (ownsDescriptor) fs.closeSync(descriptor);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}
