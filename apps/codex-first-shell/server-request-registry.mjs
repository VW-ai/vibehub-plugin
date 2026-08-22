export const SERVER_REQUEST_REGISTRY_VERSION = "codex-app-server-0.147.0";

export const SERVER_REQUEST_REGISTRY = Object.freeze({
  "item/commandExecution/requestApproval": Object.freeze({
    kind: "commandApproval",
    decisions: Object.freeze(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  "item/fileChange/requestApproval": Object.freeze({
    kind: "fileApproval",
    decisions: Object.freeze(["accept", "acceptForSession", "decline", "cancel"]),
  }),
  "item/tool/requestUserInput": Object.freeze({
    kind: "userInput",
    decisions: Object.freeze([]),
  }),
  "item/tool/call": Object.freeze({
    kind: "dynamicTool",
    decisions: Object.freeze([]),
    unsupportedByCarrier: true,
  }),
});

export function requestDescriptor(request) {
  const entry = SERVER_REQUEST_REGISTRY[request?.method];
  if (!entry) return { kind: "unsupported", supported: false, decisions: [], blocking: true };
  return {
    ...entry,
    supported: !entry.unsupportedByCarrier,
    blocking: entry.kind === "userInput" ? request.params?.isBlocking !== false : true,
  };
}

export function validateRequestDecision(request, decision) {
  return requestDescriptor(request).decisions.includes(decision);
}

export function unsupportedServerRequestResult(request) {
  if (request?.method === "item/tool/call") {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "This local VibeHub carrier does not execute client-side dynamic tools." }],
    };
  }
  return null;
}
