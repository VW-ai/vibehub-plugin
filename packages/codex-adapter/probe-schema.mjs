#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lock from "./upstream-lock.json" with { type: "json" };

function walk(value, visit) {
  if (!value || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) walk(child, visit);
}

function methodNames(schema) {
  const names = new Set();
  walk(schema, (value) => {
    const method = value?.properties?.method;
    if (typeof method?.const === "string") names.add(method.const);
    for (const item of method?.enum ?? []) if (typeof item === "string") names.add(item);
  });
  return names;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// The `type` discriminators of a tagged union such as UserInput or ThreadItem.
function variantTypes(definition) {
  const types = new Set();
  for (const variant of definition?.oneOf ?? definition?.anyOf ?? []) {
    const type = variant?.properties?.type;
    if (typeof type?.const === "string") types.add(type.const);
    for (const item of type?.enum ?? []) if (typeof item === "string") types.add(item);
  }
  return types;
}

export function probeCodexSchema({ codex = "codex" } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-codex-schema-"));
  try {
    const output = join(temp, "json");
    execFileSync(codex, ["app-server", "generate-json-schema", "--out", output], { stdio: "pipe" });
    const client = JSON.parse(readFileSync(join(output, "ClientRequest.json"), "utf8"));
    const serverRequest = JSON.parse(readFileSync(join(output, "ServerRequest.json"), "utf8"));
    const notification = JSON.parse(readFileSync(join(output, "ServerNotification.json"), "utf8"));
    const protocolPath = join(output, "codex_app_server_protocol.v2.schemas.json");
    const clientMethods = methodNames(client);
    const serverRequestMethods = methodNames(serverRequest);
    const notificationMethods = methodNames(notification);
    const protocolText = readFileSync(protocolPath, "utf8");
    const protocol = JSON.parse(protocolText);
    // Turn inputs are proven as UserInput variants and capability items as
    // ThreadItem or UserInput variants of the generated v2 protocol, never by
    // a bare string match.
    const userInputTypes = variantTypes(protocol.definitions?.UserInput);
    const threadItemTypes = variantTypes(protocol.definitions?.ThreadItem);
    const checks = [
      ...lock.requiredRequests.map((method) => ({ kind: "request", method, proven: clientMethods.has(method) })),
      ...lock.requiredServerRequests.map((method) => ({ kind: "server-request", method, proven: serverRequestMethods.has(method) })),
      ...lock.requiredNotifications.map((method) => ({ kind: "notification", method, proven: notificationMethods.has(method) })),
      ...lock.audio.stableTurnInputs.map((type) => ({ kind: "audio-input", method: type, proven: userInputTypes.has(type) })),
      ...lock.stableTurnInputs.map((type) => ({ kind: "turn-input", method: type, proven: userInputTypes.has(type) })),
      ...lock.capabilityItems.map((type) => ({ kind: "capability-item", method: type, proven: threadItemTypes.has(type) || userInputTypes.has(type) })),
    ];
    const schemaSha256 = sha256(protocolPath);
    checks.push({ kind: "schema", method: "protocol-sha256", proven: schemaSha256 === lock.codex.protocolSchemaSha256 });
    return {
      ok: checks.every((check) => check.proven),
      codex: lock.codex,
      dsh: lock.dsh,
      runtime: { node: process.version, platform: `${process.platform}-${process.arch}` },
      schemaSha256,
      experimental: {
        requestsInGeneratedClientSchema: lock.audio.experimentalRequests.filter((method) => clientMethods.has(method)),
        notificationsInGeneratedSchema: lock.requiredNotifications.filter((method) => method.startsWith("thread/realtime/") && notificationMethods.has(method)),
      },
      checks,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const result = probeCodexSchema();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
