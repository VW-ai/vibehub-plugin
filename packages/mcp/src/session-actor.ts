import crypto from "node:crypto";

export interface McpClientIdentity {
  name: string;
  version: string;
}

export interface McpSessionActorInput {
  clientInfo?: McpClientIdentity;
  sessionId?: string;
}

const actorLabel = (value: string): string => {
  const label = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return label || "client";
};

/**
 * Produce one stable attribution for an MCP connection.
 *
 * The returned value is deliberately only claimed actor attribution. It does
 * not authenticate the client or grant Ticket Decision authority. The
 * session nonce prevents two independent MCP processes with identical client
 * metadata from collapsing onto the same executor identity.
 */
export function createMcpSessionActor(
  input: McpSessionActorInput = {},
): string {
  const sessionId = input.sessionId ?? crypto.randomUUID();
  if (!sessionId.trim()) {
    throw new Error("MCP sessionId must not be empty");
  }
  const clientName = input.clientInfo?.name.trim() || "unknown-client";
  const clientVersion = input.clientInfo?.version.trim() || "unknown-version";
  const digest = crypto.createHash("sha256").update(JSON.stringify([
    "vibehub.mcp-session-actor.v1",
    sessionId,
    clientName,
    clientVersion,
  ])).digest("hex");
  return `mcp-session:${actorLabel(clientName)}:${digest}`;
}
