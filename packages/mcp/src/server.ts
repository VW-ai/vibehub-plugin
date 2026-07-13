import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCapabilities, type CapabilityContext } from "./capabilities.js";

const specType = z.enum([
  "intent", "decision", "constraint", "convention", "contract", "context", "change",
]);
const scopeItem = z.object({ glob: z.string().min(1), label: z.string().optional() });
const manifest = z.object({
  features: z.array(z.object({
    id: z.string().min(1), name: z.string().min(1), parentId: z.string().optional(),
  })),
  anchors: z.array(z.object({
    featureId: z.string().min(1), file: z.string().min(1), symbol: z.string().optional(),
  })),
  relations: z.array(z.object({
    fromId: z.string().min(1), toId: z.string().min(1), type: z.string().min(1),
  })),
});

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export function createWorkbenchMcpServer(context: CapabilityContext): McpServer {
  const api = createCapabilities(context);
  const server = new McpServer(
    { name: "vibehub-local", version: "0.1.0" },
    { instructions: "Vibehub MCP exposes deterministic local capabilities. Semantic workflows live in vibehub skills." },
  );

  server.registerTool("register_scope", {
    title: "Register session scope",
    description: "Store this task's repo-relative read/write globs and human-readable status. Replaces the previous declaration; attribution is derived later.",
    inputSchema: {
      status: z.string().min(1).max(200),
      write: z.array(scopeItem).min(1),
      read: z.array(scopeItem).optional(),
    },
  }, async (input) => result(api.registerScope(input)));

  server.registerTool("self_report", {
    title: "Update task status",
    description: "Persist one concise status line and an optional completed step. This is a mechanical task fact, not a report-writing workflow.",
    inputSchema: {
      status: z.string().min(1).max(200),
      done: z.string().min(1).max(200).optional(),
    },
  }, async (input) => result(api.selfReport(input)));

  server.registerTool("kb_retrieve", {
    title: "Run one deterministic knowledge query",
    description: "Return one ranked pass over specs bound to topic words or repo-relative paths. Use vibehub-query for multi-pass context strategy.",
    inputSchema: {
      query: z.string().min(1).optional(),
      paths: z.array(z.string().min(1)).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
  }, async (input) => result(api.kbRetrieve(input)));

  server.registerTool("kb_record", {
    title: "Persist one spec fact",
    description: "Validate and persist one already-decomposed spec as draft. IDs are server-generated; use vibehub-ingest to decompose discussions.",
    inputSchema: {
      type: specType.optional(),
      summary: z.string().min(1).max(300).optional(),
      detail: z.string().optional(),
      featureId: z.string().optional(),
      supersedes: z.string().optional(),
      marksStale: z.string().optional(),
    },
  }, async (input) => result(api.kbRecord(input)));

  server.registerTool("get_manual", {
    title: "Read the Vibehub agent manual",
    description: "Return reference material about component boundaries and available skills. Not required before routine work.",
    inputSchema: { topic: z.string().optional() },
  }, async (input) => result(api.getManual(input)));

  server.registerTool("kb_apply_distillation", {
    title: "Apply a distillation manifest",
    description: "Atomically validate and apply an already-produced feature/anchor/relation manifest, then recompute layout. Semantic mapping belongs to vibehub-distill.",
    inputSchema: manifest.shape,
  }, async (input) => result(api.kbApplyDistillation(input)));

  return server;
}
