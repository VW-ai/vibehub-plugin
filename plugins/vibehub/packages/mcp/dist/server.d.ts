import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createCapabilities, type CapabilityContext } from "./capabilities.js";
export declare const WORKBENCH_MCP_VERSION = "0.2.0";
export declare const WORKBENCH_MCP_TOOL_NAMES: readonly ["register_scope", "self_report", "kb_retrieve", "kb_operation", "distill_operation", "get_manual"];
export declare const operationEnvelopeResult: (value: ReturnType<ReturnType<typeof createCapabilities>["dispatchKnowledge"]>) => {
    content: {
        type: "text";
        text: string;
    }[];
    isError: boolean;
};
export declare function createWorkbenchMcpServer(context: CapabilityContext | PromiseLike<CapabilityContext>): McpServer;
