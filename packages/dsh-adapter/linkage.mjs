const LINK_VERSION = 1;
const TICKET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLink(value) {
  if (!plainObject(value) || value.version !== LINK_VERSION) {
    throw new Error("VibeHub Task link must use version 1");
  }
  if (typeof value.workspace !== "string" || value.workspace.trim() === "") {
    throw new Error("VibeHub Task link requires a workspace path");
  }
  if (typeof value.ticketId !== "string" || !TICKET_ID.test(value.ticketId)) {
    throw new Error("VibeHub Task link requires a canonical Ticket ID");
  }
  if (value.commit !== null && value.commit !== undefined
    && (typeof value.commit !== "string" || value.commit.trim() === "")) {
    throw new Error("VibeHub Task link commit must be a non-empty string or null");
  }
  return Object.freeze({
    version: LINK_VERSION,
    workspace: value.workspace,
    ticketId: value.ticketId,
    commit: value.commit ?? null,
  });
}

export function encodeTaskLink(value) {
  return Buffer.from(JSON.stringify(normalizeLink(value)), "utf8").toString("base64url");
}

export function decodeTaskLink(encoded) {
  if (typeof encoded !== "string" || encoded.trim() === "") {
    throw new Error("VibeHub Task link payload is empty");
  }
  if (encoded.trim().length > 4096) {
    throw new Error("VibeHub Task link payload exceeds 4096 characters");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encoded.trim(), "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("VibeHub Task link payload is not valid base64url JSON", { cause: error });
  }
  return normalizeLink(parsed);
}

export function taskLinkProjectionDefinition() {
  return {
    key: "vibehubTask",
    schema: {
      parse(value) {
        if (value === null) return null;
        if (!plainObject(value) || typeof value.runId !== "string") {
          throw new Error("invalid VibeHub Task Session projection");
        }
        return Object.freeze({ ...normalizeLink(value), runId: value.runId });
      },
    },
    init: () => ({ current: null, pending: {} }),
    apply(state, event) {
      if (event?.type === "command/run" && event.data?.name === "vibehub-task") {
        if (typeof event.data.args !== "string") return state;
        let link;
        try {
          link = decodeTaskLink(event.data.args);
        } catch {
          return state;
        }
        return {
          current: state.current,
          pending: {
            ...state.pending,
            [event.data.commandId]: link,
          },
        };
      }
      if (event?.type !== "command/done") return state;
      const link = state.pending[event.data?.commandId];
      if (link === undefined) return state;
      const pending = { ...state.pending };
      delete pending[event.data.commandId];
      return {
        current: event.data.kind === "success"
          ? { ...link, runId: event.data.commandId }
          : state.current,
        pending,
      };
    },
    view: (state) => state.current,
    stateVersion: 1,
  };
}
