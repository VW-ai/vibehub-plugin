#!/usr/bin/env node

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = join(repositoryRoot, "apps", "dsh-persistent-shell-prototype");
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
  ["/", [join(assetDirectory, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [join(assetDirectory, "index.html"), "text/html; charset=utf-8"]],
  ["/app.css", [join(assetDirectory, "app.css"), "text/css; charset=utf-8"]],
  ["/app.js", [join(assetDirectory, "app.js"), "text/javascript; charset=utf-8"]],
  ["/vibehub-mark.svg", [join(repositoryRoot, "assets", "brand", "vibehub-mark.svg"), "image/svg+xml"]],
]);

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("Method not allowed");
    return;
  }
  if (url.pathname === "/health") {
    response.writeHead(200, { ...securityHeaders, "content-type": "application/json; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({
      ok: true,
      prototype: "dsh-persistent-shell",
      upstream: "@deepseek-ai/dsh@0.1.0-rc.8",
      localOnly: true,
      repositoryWrites: false,
    }));
    return;
  }
  const asset = files.get(url.pathname);
  if (!asset) {
    response.writeHead(404, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(asset[0]);
    response.writeHead(200, { ...securityHeaders, "content-type": asset[1] });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    response.writeHead(500, { ...securityHeaders, "content-type": "text/plain; charset=utf-8" });
    response.end(`Unable to read prototype asset: ${error.message}`);
  }
});

server.on("error", (error) => {
  process.stderr.write(`Unable to start persistent-shell prototype: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;
  const envelope = { ok: true, url, pid: process.pid, localOnly: true, ephemeralState: true, repositoryWrites: false };
  process.stdout.write(`${argumentsList.includes("--json") ? JSON.stringify(envelope) : `VibeHub persistent shell prototype: ${url}`}\n`);
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
