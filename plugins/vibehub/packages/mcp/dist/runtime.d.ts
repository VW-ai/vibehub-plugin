import type { CapabilityContext } from "./capabilities.js";
export interface RuntimeContext {
    context: CapabilityContext;
    close(): void;
}
/** Derive the MCP domain from the project cwd; no parallel repo/task config. */
export declare function openRuntimeContext(cwd: string, dbPath: string, now?: () => string): RuntimeContext;
export declare function openRuntimeContextFromRoots(roots: Array<{
    uri: string;
}>, dbPath: string, now?: () => string): RuntimeContext;
export declare function openRuntimeContextForClient(input: {
    supportsRoots: boolean;
    listRoots: () => Promise<Array<{
        uri: string;
    }>>;
    cwd: string;
    dbPath: string;
    now?: () => string;
}): Promise<RuntimeContext>;
