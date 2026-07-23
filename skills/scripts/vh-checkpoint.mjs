#!/usr/bin/env node
import fs from "node:fs";
import { captureCommand } from "./_capture.mjs";

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
const forwarded = [];
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--input") {
    inputPath = argv[++index] ?? fail("--input needs a file or -");
  } else if (["--repo", "--actor", "--task", "--request", "--protect"].includes(flag)) {
    const value = argv[++index];
    if (value === undefined) fail(`${flag} needs a value`);
    forwarded.push(flag, value);
  } else {
    fail(`unknown flag: ${flag}`);
  }
}

let input;
if (operation === "commit") {
  try {
    input = fs.readFileSync(inputPath === "-" ? 0 : inputPath, "utf8").trim();
    JSON.parse(input);
  } catch (error) {
    fail(`invalid checkpoint receipt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const binary = process.env.VIBEHUB_BIN || "vibehub";
const child = await captureCommand(
  binary,
  ["checkpoint", operation, "--json", ...forwarded, ...(operation === "commit" ? ["--input", "-"] : [])],
  { input, env: process.env },
);
if (child.kind === "overflow") fail(`vibehub CLI response exceeded ${child.limit} bytes`, "response_too_large", 1);
if (child.kind === "spawn_error") fail(`cannot execute vibehub CLI: ${child.error.message}`, "internal_error", 1);
if (child.kind === "signal") fail(`vibehub CLI terminated by signal ${child.signal}`, "cli_terminated", 1);
const output = child.stdout.trim();
try {
  JSON.parse(output);
} catch {
  fail("vibehub CLI returned a non-JSON response", "internal_error", 1);
}
fs.writeSync(1, `${output}\n`);
process.exit(child.status);
