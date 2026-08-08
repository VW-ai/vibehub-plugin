#!/usr/bin/env node
// User-owned Workbench session (Phase 0 of the Workbench baseline): the same
// read-only Ticket graph host as Agent presentation, but the lifetime belongs
// to this foreground command instead of an Agent task's expiring token.
// Stopping the process ends the host and invalidates the URL.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, parseUiFlags, startVibeHubUi } from "./vh-ui.mjs";

async function launch(argv) {
  const flags = parseUiFlags(argv);
  const handle = startVibeHubUi({
    repoRoot: flags.repo,
    port: flags.port,
    ticket: flags.ticket,
    view: flags.view,
    tokenLifetimeMs: null,
  });
  const ready = await handle.ready;
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      readOnly: true,
      sessionOwner: "user",
      repo: flags.repo,
      opened: flags.open,
      ...ready,
    })}\n`);
  } else {
    process.stdout.write([
      "VibeHub Workbench session (read-only)",
      ready.url,
      "The session belongs to this foreground command. Press Ctrl+C to stop.",
      "",
    ].join("\n"));
  }
  if (flags.open) openBrowser(ready.url);
  const close = () => void handle.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await handle.closed;
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  launch(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
