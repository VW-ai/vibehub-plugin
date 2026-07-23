import { type Db } from "@vibehub/core";
export interface CapabilityContext {
    db: Db;
    repoId: number;
    taskId: string;
    repoRoot?: string;
    actor?: string;
    requestId?: () => string;
    now?: () => string;
}
export declare function createCapabilities(ctx: CapabilityContext): {
    registerScope(input: {
        status: string;
        write: Array<{
            glob: string;
            label?: string;
        }>;
        read?: Array<{
            glob: string;
            label?: string;
        }>;
    }): {
        patterns: number;
    };
    selfReport(input: {
        status: string;
        done?: string;
    }): {
        done: string | null;
        status: string;
        reportedAt: string;
    };
    dispatchOperation(operation: string, input?: Record<string, unknown>, requestId?: string): import("@vibehub/core").OperationResult<unknown>;
    dispatchKnowledge(operation: string, input?: Record<string, unknown>, requestId?: string): import("@vibehub/core").OperationResult<unknown>;
    getManual(_input?: {
        topic?: string;
    }): {
        text: string;
    };
};
