// rc.8 Host API translation boundary. The installable Bundle entry only
// re-exports this adapter and owns no DSH service calls.
import { resolve } from "node:path";
import { decodeTaskLink, taskLinkProjectionDefinition } from "./linkage.mjs";
import { buildUiSnapshot, startVibeHubUi } from "../vendor/skills/scripts/vh-ui.mjs";

export const name = "vibehub";
export const inject = ["commands", "sessionProjections", "webServer"];

function writeJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

export function apply(ctx, config = {}) {
  const repoRoot = resolve(config.repoRoot ?? process.cwd());
  const dshOrigins = [
    `http://127.0.0.1:${ctx.webServer.port}`,
    `http://localhost:${ctx.webServer.port}`,
  ];
  const graph = startVibeHubUi({ repoRoot, embeddedOrigins: dshOrigins });
  const graphReady = graph.ready;

  ctx.effect(() => () => graph.close(), "vibehub: close Ticket Graph host");
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/vibehub/bootstrap",
    handler: async (request, response) => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { ok: false, error: "read_only" });
        return;
      }
      const ready = await graphReady;
      const source = buildUiSnapshot(repoRoot).state.graph.source;
      writeJson(response, 200, {
        ok: true,
        version: 1,
        repoRoot,
        graphUrl: ready.url,
        source: {
          branch: source.branch,
          commit: source.resolvedCommit,
          graphDigest: source.graphDigest,
        },
      });
    },
  }), "vibehub: bootstrap route");

  ctx.commands.register({
    name: "vibehub-task",
    description: "Link the current native DSH Session to one canonical VibeHub Task",
    input: { hint: "<VibeHub Task link>" },
    recordInput: true,
    handler: ({ rawInput }) => {
      let link;
      try {
        link = decodeTaskLink(rawInput);
      } catch (error) {
        return { kind: "error", text: error instanceof Error ? error.message : String(error) };
      }
      if (resolve(link.workspace) !== repoRoot) {
        return { kind: "error", text: "The Task link belongs to another Workspace." };
      }
      const snapshot = buildUiSnapshot(repoRoot);
      if (!snapshot.state.graph.tickets.some((ticket) => ticket.ticketId === link.ticketId)) {
        return { kind: "error", text: `Unknown VibeHub Ticket: ${link.ticketId}` };
      }
      return { kind: "success", text: `Linked ${link.ticketId} to this DSH Session.` };
    },
  });

  ctx.sessionProjections.register(taskLinkProjectionDefinition());
  ctx.logger.info("VibeHub Task Workbench mounted without replacing native DSH Chat");
}
