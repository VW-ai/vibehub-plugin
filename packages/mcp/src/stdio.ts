#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveDbPath } from "@vibehub/core";
import { openRuntimeContext } from "./runtime.js";
import { createWorkbenchMcpServer } from "./server.js";

const runtime = openRuntimeContext(process.cwd(), resolveDbPath());
const server = createWorkbenchMcpServer(runtime.context);

const close = async (): Promise<void> => {
  await server.close();
  runtime.close();
};

process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
