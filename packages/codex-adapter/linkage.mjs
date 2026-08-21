const LINK_VERSION = 1;
const TICKET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value) {
  if (!plainObject(value) || value.version !== LINK_VERSION) {
    throw new Error("VibeHub Codex Thread link must use version 1");
  }
  if (typeof value.workspace !== "string" || value.workspace.trim() === "") {
    throw new Error("VibeHub Codex Thread link requires a workspace path");
  }
  if (typeof value.ticketId !== "string" || !TICKET_ID.test(value.ticketId)) {
    throw new Error("VibeHub Codex Thread link requires a canonical Ticket ID");
  }
  if (typeof value.codexThreadId !== "string" || value.codexThreadId.trim() === "") {
    throw new Error("VibeHub Codex Thread link requires a Codex Thread ID");
  }
  return Object.freeze({
    version: LINK_VERSION,
    workspace: value.workspace,
    ticketId: value.ticketId,
    codexThreadId: value.codexThreadId,
  });
}

export function encodeCodexThreadLink(value) {
  return Buffer.from(JSON.stringify(normalize(value)), "utf8").toString("base64url");
}

export function decodeCodexThreadLink(encoded) {
  if (typeof encoded !== "string" || encoded.trim() === "") {
    throw new Error("VibeHub Codex Thread link payload is empty");
  }
  if (encoded.trim().length > 4096) {
    throw new Error("VibeHub Codex Thread link payload exceeds 4096 characters");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("VibeHub Codex Thread link is not valid base64url JSON", { cause: error });
  }
  return normalize(parsed);
}

export function codexThreadLinkProjectionDefinition() {
  return {
    key: "vibehubCodexThread",
    schema: {
      parse(value) {
        if (value === null) return null;
        if (!plainObject(value) || typeof value.commandId !== "string") {
          throw new Error("invalid VibeHub Codex Thread Session projection");
        }
        return Object.freeze({ ...normalize(value), commandId: value.commandId });
      },
    },
    init: () => ({ current: null, pending: {} }),
    apply(state, event) {
      if (event?.type === "command/run" && event.data?.name === "vibehub-codex-thread") {
        if (typeof event.data.args !== "string") return state;
        let link;
        try {
          link = decodeCodexThreadLink(event.data.args);
        } catch {
          return state;
        }
        return {
          current: state.current,
          pending: { ...state.pending, [event.data.commandId]: link },
        };
      }
      if (event?.type !== "command/done") return state;
      const link = state.pending[event.data?.commandId];
      if (link === undefined) return state;
      const pending = { ...state.pending };
      delete pending[event.data.commandId];
      return {
        current: event.data.kind === "success"
          ? { ...link, commandId: event.data.commandId }
          : state.current,
        pending,
      };
    },
    view: (state) => state.current,
    stateVersion: 1,
  };
}
