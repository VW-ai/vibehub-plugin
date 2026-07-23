import { type CanonicalHookEvent, type CanonicalToolTouch, type HookDeliveryDirective, type HookEventName, type HookHost } from "@vibehub/core";
export type AdaptedHookInput = {
    kind: "event";
    event: CanonicalHookEvent;
} | {
    kind: "ignored";
    reason: "codex_subagent_event";
};
/**
 * Extract paths from Codex's validated apply_patch envelope. The host has
 * already executed the patch successfully before PostToolUse; this parser
 * deliberately consumes only path headers and never interprets code hunks.
 */
export declare function codexApplyPatchTouches(command: string): CanonicalToolTouch[];
export declare function adaptClaudeCodeHook(eventName: HookEventName, raw: unknown): AdaptedHookInput;
export declare function adaptCodexHook(eventName: HookEventName, raw: unknown): AdaptedHookInput;
export declare function adaptHookInput(host: HookHost, eventName: HookEventName, raw: unknown): AdaptedHookInput;
export type HookWireOutput = {
    hookSpecificOutput: {
        hookEventName: string;
        additionalContext: string;
    };
} | {
    decision: "block";
    reason: string;
};
export declare function projectClaudeCodeHookOutput(delivery: HookDeliveryDirective): HookWireOutput;
export declare function projectCodexHookOutput(delivery: HookDeliveryDirective): HookWireOutput;
export declare function projectHookOutput(host: HookHost, delivery: HookDeliveryDirective): HookWireOutput;
