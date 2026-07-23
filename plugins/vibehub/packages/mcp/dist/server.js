import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { operationContextSchema } from "@vibehub/core";
import { z } from "zod";
import { createCapabilities } from "./capabilities.js";
const scopeItem = z.object({ glob: z.string().min(1), label: z.string().optional() });
const logicalRequestId = operationContextSchema.shape.requestId.optional();
export const WORKBENCH_MCP_VERSION = "0.2.0";
export const WORKBENCH_MCP_TOOL_NAMES = [
    "register_scope", "self_report", "kb_retrieve", "kb_operation", "distill_operation", "get_manual",
];
const result = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
export const operationEnvelopeResult = (value) => ({
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: !value.ok,
});
export function createWorkbenchMcpServer(context) {
    const api = async () => createCapabilities(await context);
    const server = new McpServer({ name: "vibehub-local", version: WORKBENCH_MCP_VERSION }, { instructions: "Vibehub MCP exposes deterministic local capabilities. Semantic workflows live in vibehub skills." });
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[0], {
        title: "Register session scope",
        description: "Store this task's repo-relative read/write globs and human-readable status. Replaces the previous declaration; attribution is derived later.",
        inputSchema: {
            status: z.string().min(1).max(200),
            write: z.array(scopeItem).min(1),
            read: z.array(scopeItem).optional(),
        },
    }, async (input) => result((await api()).registerScope(input)));
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[1], {
        title: "Update task status",
        description: "Persist one concise status line and an optional completed step. This is a mechanical task fact, not a report-writing workflow.",
        inputSchema: {
            status: z.string().min(1).max(200),
            done: z.string().min(1).max(200).optional(),
        },
    }, async (input) => result((await api()).selfReport(input)));
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[2], {
        title: "Run one deterministic knowledge query",
        description: "Return one ranked pass over specs bound to topic words or repo-relative paths. Use vibehub-query for multi-pass context strategy.",
        inputSchema: {
            query: z.string().min(1).optional(),
            paths: z.array(z.string().min(1)).optional(),
            limit: z.number().int().min(1).max(50).optional(),
            includeDrafts: z.boolean().optional(),
            includeHistory: z.boolean().optional(),
        },
    }, async (input) => operationEnvelopeResult((await api()).dispatchKnowledge("kb.spec.search", input)));
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[3], {
        title: "Dispatch one canonical knowledge operation",
        description: "Symmetric adapter over the shared OperationDispatcher. Returns the exact success/error envelope used by `vibehub kb ... --json`.",
        inputSchema: {
            requestId: logicalRequestId,
            operation: z.string().min(1),
            input: z.record(z.string(), z.unknown()).optional(),
        },
    }, async ({ operation, input, requestId }) => operationEnvelopeResult((await api()).dispatchKnowledge(operation, input ?? {}, requestId)));
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[4], {
        title: "Dispatch one deterministic distillation operation",
        description: "Symmetric adapter over DistillationService through the shared OperationDispatcher. Skills own semantic choices; this tool only validates and persists run mechanics.",
        inputSchema: {
            requestId: logicalRequestId,
            operation: z.string().min(1),
            input: z.record(z.string(), z.unknown()).optional(),
        },
    }, async ({ operation, input, requestId }) => operationEnvelopeResult((await api()).dispatchOperation(operation, input ?? {}, requestId)));
    server.registerTool(WORKBENCH_MCP_TOOL_NAMES[5], {
        title: "Read the Vibehub agent manual",
        description: "Return reference material about component boundaries and available skills. Not required before routine work.",
        inputSchema: { topic: z.string().optional() },
    }, async (input) => result((await api()).getManual(input)));
    return server;
}
