#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const assetDirectory = join(scriptDirectory, "..", "apps", "harness-interaction-research");
const argumentsList = process.argv.slice(2);

function readFlag(name) {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : null;
}

const requestedPort = Number(readFlag("--port") ?? 0);
if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
  process.stderr.write("--port must be an integer from 0 to 65535\n");
  process.exit(1);
}

const files = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.css", ["app.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }
  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, board: "task-workbench-interaction-research", localOnly: true }));
    return;
  }
  const asset = files.get(url.pathname);
  if (!asset) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(join(assetDirectory, asset[0]));
    response.writeHead(200, {
      "content-type": asset[1],
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Unable to read interaction research asset: ${error.message}`);
  }
});

server.on("error", (error) => {
  process.stderr.write(`Unable to start the interaction research board: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const envelope = { ok: true, url, pid: process.pid, localOnly: true, mockedState: true };
  process.stdout.write(`${argumentsList.includes("--json") ? JSON.stringify(envelope) : `VibeHub interaction research: ${url}`}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
