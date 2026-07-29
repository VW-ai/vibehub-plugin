#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolveVibehubInvocation } from "./_dispatch.mjs";

const invocation = resolveVibehubInvocation();
const child = spawn(
  invocation.command,
  [...invocation.prefix, "ticket", "review", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: process.env,
  },
);

child.once("error", (error) => {
  process.stderr.write(
    `cannot execute the VibeHub Ticket review host: ${error.message}\n`,
  );
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.stderr.write(
      `VibeHub Ticket review host exited on signal ${signal}\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
