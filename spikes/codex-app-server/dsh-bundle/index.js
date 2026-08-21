import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexAppServerClient } from "./adapter/client.mjs";
import { startCodexTask } from "./adapter/handoff.mjs";
import {
  codexThreadLinkProjectionDefinition,
  decodeCodexThreadLink,
} from "./adapter/linkage.mjs";

export const name = "vibehub-codex-adapter-spike";
export const inject = ["commands", "sessionProjections", "webServer"];

function writeJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

export function apply(ctx, config = {}) {
  const repoRoot = resolve(config.repoRoot ?? process.cwd());
  const client = new CodexAppServerClient({
    cwd: repoRoot,
    clientInfo: { name: "vibehub-dsh-spike", title: "VibeHub DSH Codex spike", version: "0.0.1" },
    experimentalApi: true,
  });
  const state = {
    status: "starting",
    authenticated: false,
    accountType: null,
    planType: null,
    requiresOpenaiAuth: null,
    error: null,
  };
  const ready = client.start()
    .then(() => client.accountStatus())
    .then((account) => Object.assign(state, { status: "ready", ...account }))
    .catch((error) => Object.assign(state, { status: "failed", error: error.message }));

  ctx.effect(() => () => client.stop(), "vibehub: stop Codex app-server spike");
  ctx.commands.register({
    name: "vibehub-codex-thread",
    description: "Persist one VibeHub Task to Codex Thread association in this DSH Session",
    input: { hint: "<VibeHub Codex Thread link>" },
    recordInput: true,
    handler: ({ rawInput }) => {
      let link;
      try {
        link = decodeCodexThreadLink(rawInput);
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
      if (resolve(link.workspace) !== repoRoot) {
        return { kind: "error", text: "The Codex Thread link belongs to another Workspace." };
      }
      return { kind: "success", text: `Linked ${link.ticketId} to Codex Thread ${link.codexThreadId}.` };
    },
  });
  ctx.commands.register({
    name: "vibehub-codex-start",
    description: "Start one canonical host-owned VibeHub Task handoff in Codex app-server",
    input: { hint: "<canonical Ticket ID>" },
    recordInput: true,
    handler: async ({ rawInput }) => {
      const ticketId = rawInput.trim();
      try {
        const source = pathToFileURL(join(repoRoot, "skills/scripts/vh-ui.mjs")).href;
        const { buildTicketHandoff } = await import(source);
        const payload = buildTicketHandoff(repoRoot, ticketId);
        const started = await startCodexTask({ client, payload, cwd: repoRoot });
        return {
          kind: "success",
          text: `Started ${started.ticketId} in Codex Thread ${started.threadId}.`,
        };
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
    },
  });
  ctx.sessionProjections.register(codexThreadLinkProjectionDefinition());
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/vibehub/codex-adapter-spike",
    handler: async (request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { ok: false, error: "read_only" });
        return;
      }
      await ready;
      writeJson(response, state.status === "ready" ? 200 : 503, {
        ok: state.status === "ready",
        localOnly: true,
        repositoryWrites: false,
        adapter: "codex-app-server-0.147.0",
        ...state,
      });
    },
  }), "vibehub: Codex adapter spike health route");
}
