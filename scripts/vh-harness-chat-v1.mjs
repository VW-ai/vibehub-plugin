#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const assetDirectory = join(scriptDirectory, "..", "apps", "harness-chat-v1");
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const port = Number(flag("--port") ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
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
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ ok: true, prototype: "harness-chat-v1", localOnly: true }));
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
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Unable to read prototype asset: ${error.message}`);
  }
});

server.on("error", (error) => {
  process.stderr.write(`Unable to start Harness Chat prototype: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const envelope = { ok: true, url, pid: process.pid, localOnly: true, ephemeralState: true };
  process.stdout.write(`${args.includes("--json") ? JSON.stringify(envelope) : `VibeHub Harness Chat: ${url}`}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
