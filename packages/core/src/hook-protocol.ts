import type { HookEventName } from "./state-machine.js";

/** Runtime hosts whose lifecycle evidence has a validated VibeHub adapter. */
export type HookHost = "claude-code" | "codex";

export interface CanonicalToolTouch {
  action: "edit" | "read";
  /** Host-reported path. Core resolves it from cwd and enforces repo bounds. */
  path: string;
}

/**
 * Host-neutral lifecycle fact consumed by the transactional ingestion core.
 * Host wire parsing and stdout projection belong to the CLI adapters.
 */
export interface CanonicalHookEvent {
  host: HookHost;
  eventName: HookEventName;
  sessionId: string;
  transcriptPath?: string;
  cwd: string;
  promptIdentity?: string;
  prompt?: string;
  toolName?: string;
  toolTouches?: CanonicalToolTouch[];
  message?: string;
  reason?: string;
  assistantText?: string;
  error?: string;
  errorDetails?: string;
}

/** Host-neutral delivery effect committed atomically with its queue claim. */
export type HookDeliveryDirective =
  | {
      kind: "additional_context";
      hookEventName: HookEventName;
      additionalContext: string;
    }
  | {
      kind: "continue_turn";
      reason: string;
    };
