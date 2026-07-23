import { lastAssistantText, } from "@vibehub/core";
function record(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("hook payload must be a JSON object");
    }
    return value;
}
function requiredString(value, field) {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string`);
    }
    return value;
}
function optionalString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function assertEvent(payload, eventName) {
    const wireName = payload["hook_event_name"];
    if (wireName !== undefined && wireName !== eventName) {
        throw new Error(`hook event mismatch: expected ${eventName}, received ${String(wireName)}`);
    }
}
function directToolTouches(payload) {
    const toolName = optionalString(payload["tool_name"]);
    const input = payload["tool_input"];
    if (!toolName || typeof input !== "object" || input === null || Array.isArray(input))
        return [];
    const file = optionalString(input["file_path"]);
    if (!file)
        return [];
    if (new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]).has(toolName)) {
        return [{ action: "edit", path: file }];
    }
    return toolName === "Read" ? [{ action: "read", path: file }] : [];
}
/**
 * Extract paths from Codex's validated apply_patch envelope. The host has
 * already executed the patch successfully before PostToolUse; this parser
 * deliberately consumes only path headers and never interprets code hunks.
 */
export function codexApplyPatchTouches(command) {
    const paths = [];
    for (const line of command.split(/\r?\n/)) {
        const match = /^\*\*\* (?:Add File|Delete File|Update File|Move to): (.+)$/.exec(line);
        if (match?.[1])
            paths.push(match[1]);
    }
    return [...new Set(paths)].map((path) => ({ action: "edit", path }));
}
function codexToolTouches(payload) {
    if (payload["tool_name"] !== "apply_patch")
        return directToolTouches(payload);
    const input = payload["tool_input"];
    const command = typeof input === "string"
        ? optionalString(input)
        : typeof input === "object" && input !== null && !Array.isArray(input)
            ? optionalString(input["command"])
                ?? optionalString(input["patch"])
                ?? optionalString(input["input"])
            : undefined;
    return command ? codexApplyPatchTouches(command) : [];
}
function sharedEventFields(host, eventName, payload) {
    assertEvent(payload, eventName);
    const transcriptPath = optionalString(payload["transcript_path"]);
    return {
        host,
        eventName,
        sessionId: host === "codex"
            ? `codex:${requiredString(payload["session_id"], "session_id")}`
            : requiredString(payload["session_id"], "session_id"),
        cwd: requiredString(payload["cwd"], "cwd"),
        ...(transcriptPath ? { transcriptPath } : {}),
    };
}
export function adaptClaudeCodeHook(eventName, raw) {
    const payload = record(raw);
    const transcriptPath = optionalString(payload["transcript_path"]);
    const assistantText = eventName === "Stop"
        ? optionalString(payload["last_assistant_message"])
            ?? (transcriptPath ? lastAssistantText(transcriptPath) ?? undefined : undefined)
        : undefined;
    const touches = eventName === "PostToolUse" ? directToolTouches(payload) : [];
    return {
        kind: "event",
        event: {
            ...sharedEventFields("claude-code", eventName, payload),
            ...(optionalString(payload["prompt_id"])
                ? { promptIdentity: optionalString(payload["prompt_id"]) }
                : {}),
            ...(optionalString(payload["prompt"]) ? { prompt: optionalString(payload["prompt"]) } : {}),
            ...(optionalString(payload["tool_name"]) ? { toolName: optionalString(payload["tool_name"]) } : {}),
            ...(touches.length > 0 ? { toolTouches: touches } : {}),
            ...(optionalString(payload["message"]) ? { message: optionalString(payload["message"]) } : {}),
            ...(optionalString(payload["reason"]) ? { reason: optionalString(payload["reason"]) } : {}),
            ...(assistantText ? { assistantText } : {}),
            ...(optionalString(payload["error"]) ? { error: optionalString(payload["error"]) } : {}),
            ...(optionalString(payload["error_details"])
                ? { errorDetails: optionalString(payload["error_details"]) }
                : {}),
        },
    };
}
export function adaptCodexHook(eventName, raw) {
    const payload = record(raw);
    if ((eventName === "UserPromptSubmit" || eventName === "PostToolUse")
        && optionalString(payload["agent_id"])) {
        return { kind: "ignored", reason: "codex_subagent_event" };
    }
    const rawSessionId = requiredString(payload["session_id"], "session_id");
    const turnScoped = new Set([
        "UserPromptSubmit",
        "PostToolUse",
        "Stop",
        "SubagentStop",
    ]).has(eventName);
    const turnId = turnScoped
        ? requiredString(payload["turn_id"], "turn_id")
        : optionalString(payload["turn_id"]);
    const touches = eventName === "PostToolUse" ? codexToolTouches(payload) : [];
    return {
        kind: "event",
        event: {
            ...sharedEventFields("codex", eventName, payload),
            ...(eventName === "UserPromptSubmit" && turnId
                ? { promptIdentity: `codex:${rawSessionId}:${turnId}` }
                : {}),
            ...(optionalString(payload["prompt"]) ? { prompt: optionalString(payload["prompt"]) } : {}),
            ...(optionalString(payload["tool_name"]) ? { toolName: optionalString(payload["tool_name"]) } : {}),
            ...(touches.length > 0 ? { toolTouches: touches } : {}),
            ...(optionalString(payload["reason"]) ? { reason: optionalString(payload["reason"]) } : {}),
            ...(eventName === "Stop" && optionalString(payload["last_assistant_message"])
                ? { assistantText: optionalString(payload["last_assistant_message"]) }
                : {}),
        },
    };
}
export function adaptHookInput(host, eventName, raw) {
    return host === "codex"
        ? adaptCodexHook(eventName, raw)
        : adaptClaudeCodeHook(eventName, raw);
}
export function projectClaudeCodeHookOutput(delivery) {
    return delivery.kind === "continue_turn"
        ? { decision: "block", reason: delivery.reason }
        : {
            hookSpecificOutput: {
                hookEventName: delivery.hookEventName,
                additionalContext: delivery.additionalContext,
            },
        };
}
export function projectCodexHookOutput(delivery) {
    // Codex intentionally implements the Claude-compatible wire for the
    // events VibeHub uses. Keep this projector separate so protocol drift is
    // explicit and independently pinned by tests.
    return delivery.kind === "continue_turn"
        ? { decision: "block", reason: delivery.reason }
        : {
            hookSpecificOutput: {
                hookEventName: delivery.hookEventName,
                additionalContext: delivery.additionalContext,
            },
        };
}
export function projectHookOutput(host, delivery) {
    return host === "codex"
        ? projectCodexHookOutput(delivery)
        : projectClaudeCodeHookOutput(delivery);
}
