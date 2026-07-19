#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "@vibehub/core";
import {
  openRuntimeContextForClient,
  type RuntimeContext,
} from "./runtime.js";
import { createWorkbenchMcpServer } from "./server.js";

let runtime: RuntimeContext | null = null;
let resolveContext!: (context: RuntimeContext["context"]) => void;
let rejectContext!: (error: unknown) => void;
const context = new Promise<RuntimeContext["context"]>((resolve, reject) => {
  resolveContext = resolve;
  rejectContext = reject;
});
const server = createWorkbenchMcpServer(context);
server.server.oninitialized = async () => {
  try {
    runtime = await openRuntimeContextForClient({
      supportsRoots: server.server.getClientCapabilities()?.roots !== undefined,
      listRoots: async () => (await server.server.listRoots()).roots,
      cwd: process.cwd(),
      dbPath: resolveDbPath(),
    });
    resolveContext(runtime.context);
  } catch (error) {
    rejectContext(error);
    throw error;
  }
};

const close = async (): Promise<void> => {
  await server.close();
  runtime?.close();
};

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
