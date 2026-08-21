// rc.8 browser API translation boundary. Product Bundle composition points
// here through package.json#exports["./client"].
window.__ModuleLoader__.load({
  id: "@vibehub/dsh-vibehub",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const { jsx, jsxs } = require("react/jsx-runtime");
    const { useEffect, useRef, useState } = require("react");

    const styleId = "vibehub/dsh-task-workbench.css";
    if (!document.querySelector(`style[data-plugin-css="${styleId}"]`)) {
      const style = document.createElement("style");
      style.dataset.pluginCss = styleId;
      style.textContent = `
        .vh-dsh-view{position:relative;width:100%;height:100%;min-height:480px;background:var(--dsw-alias-bg-base,#fff)}
        .vh-dsh-frame{display:block;width:100%;height:100%;min-height:480px;border:0;background:transparent}
        .vh-dsh-overlay{position:fixed;inset:0;z-index:30;pointer-events:auto;background:var(--dsw-alias-bg-base,#fff)}
        .vh-dsh-overlay .vh-dsh-view{height:100dvh;min-height:0}
        .vh-dsh-overlay .vh-dsh-frame{height:100dvh;min-height:0}
        .vh-dsh-dismiss,.vh-dsh-launcher{appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#777) 24%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#fff) 95%,transparent);color:var(--dsw-alias-label-primary,#242424);box-shadow:0 8px 28px rgba(0,0,0,.1);font:600 12px/1 system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(14px)}
        .vh-dsh-dismiss{position:absolute;z-index:4;top:12px;right:12px;width:30px;height:30px;border-radius:9px;font-size:16px;font-weight:450}
        .vh-dsh-launcher{position:fixed;z-index:3;right:16px;bottom:16px;pointer-events:auto;padding:9px 12px;border-radius:10px}
        .vh-dsh-dismiss:hover,.vh-dsh-launcher:hover{background:var(--dsw-alias-bg-hover,#f4f4f4)}
        .vh-dsh-dismiss:focus-visible,.vh-dsh-launcher:focus-visible{outline:2px solid var(--dsw-alias-state-focus,#4688f1);outline-offset:2px}
        .vh-dsh-status{position:absolute;z-index:5;top:10px;left:50%;transform:translateX(-50%);max-width:min(560px,calc(100% - 88px));padding:7px 11px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-tertiary,#777) 22%,transparent);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-module-platform,#fff) 94%,transparent);box-shadow:0 7px 24px rgba(0,0,0,.09);color:var(--dsw-alias-label-secondary,#555);font:500 12px/1.35 system-ui,sans-serif;backdrop-filter:blur(14px)}
        .vh-dsh-status[data-kind=error]{color:var(--dsw-alias-state-danger,#b42318)}
        .vh-dsh-status[data-kind=success]{color:var(--dsw-alias-state-success,#18864b)}
        @media (prefers-reduced-motion:reduce){.vh-dsh-dismiss,.vh-dsh-launcher{scroll-behavior:auto}}
      `;
      document.head.appendChild(style);
    }

    function encodeLink(link) {
      const bytes = new TextEncoder().encode(JSON.stringify(link));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    }

    function taskIdOf(payload) {
      return payload?.ticketId
        ?? payload?.ticket?.ticketId
        ?? payload?.task?.ticketId
        ?? null;
    }

    function TaskSurface({
      getConnection,
      initialLink = null,
      initialSessionId = null,
      onDismiss = null,
      useSessions,
    }) {
      const frameRef = useRef(null);
      const sendingRef = useRef(false);
      const wasRunningRef = useRef(false);
      const [bootstrap, setBootstrap] = useState(null);
      const [frameLoaded, setFrameLoaded] = useState(false);
      const [link, setLink] = useState(initialLink);
      const [sessionId, setSessionId] = useState(initialSessionId);
      const [status, setStatus] = useState({ kind: "loading", text: "Connecting VibeHub…" });
      const running = useSessions((state) => sessionId ? Boolean(state.byId[sessionId]?.running) : false);
      const pending = useSessions((state) => sessionId
        ? state.byId[sessionId]?.pendingInteraction ?? null
        : null);

      useEffect(() => {
        setLink(initialLink);
        setSessionId(initialSessionId);
      }, [initialLink?.ticketId, initialLink?.runId, initialSessionId]);

      useEffect(() => {
        let cancelled = false;
        fetch("/vibehub/bootstrap", { headers: { Accept: "application/json" } })
          .then((response) => response.json())
          .then((value) => {
            if (cancelled || !value.ok) return;
            const url = new URL(value.graphUrl);
            url.searchParams.set("scope", "current");
            url.searchParams.set("embed", "dsh");
            url.searchParams.set("parentOrigin", location.origin);
            if (link?.ticketId) url.searchParams.set("ticket", link.ticketId);
            setFrameLoaded(false);
            setBootstrap({ ...value, graphUrl: url.toString() });
            setStatus(null);
          })
          .catch((error) => {
            if (!cancelled) setStatus({ kind: "error", text: String(error) });
          });
        return () => { cancelled = true; };
      }, [link?.ticketId]);

      useEffect(() => {
        const graphOrigin = bootstrap ? new URL(bootstrap.graphUrl).origin : null;
        const receive = async (event) => {
          if (graphOrigin === null || event.origin !== graphOrigin || event.source !== frameRef.current?.contentWindow) return;
          if (event.data?.type !== "vibehub-agent-handoff" || sendingRef.current) return;
          const payload = event.data.payload;
          const ticketId = taskIdOf(payload);
          if (!ticketId) {
            setStatus({ kind: "error", text: "The canonical handoff did not name a Ticket." });
            return;
          }
          sendingRef.current = true;
          try {
            setStatus({ kind: "loading", text: `Starting ${ticketId} in native Chat…` });
            const connection = await getConnection(bootstrap.repoRoot);
            if (!connection?.session || !connection?.sessionId) {
              setStatus({ kind: "error", text: "A native DSH Session is unavailable." });
              return;
            }
            setSessionId(connection.sessionId);
            const encoded = encodeLink({
              version: 1,
              workspace: bootstrap.repoRoot,
              ticketId,
              commit: bootstrap.source?.commit ?? null,
            });
            const command = await connection.session.command(`/vibehub-task ${encoded}`);
            if (!command.ok || !command.value.matched) {
              setStatus({ kind: "error", text: "DSH rejected the VibeHub Task linkage." });
              return;
            }
            const prompted = await connection.session.prompt([
              { type: "text", text: JSON.stringify(payload, null, 2) },
            ], "queue");
            if (!prompted.ok) {
              setStatus({ kind: "error", text: prompted.error?.message ?? "Native Chat rejected the Task." });
              return;
            }
            setLink({ ticketId, runId: `session:${connection.sessionId}` });
            setStatus({ kind: "success", text: `${ticketId} is running in native Chat.` });
            setTimeout(() => setStatus(null), 2400);
          } catch (error) {
            setStatus({
              kind: "error",
              text: error instanceof Error ? error.message : String(error),
            });
          } finally {
            sendingRef.current = false;
          }
        };
        window.addEventListener("message", receive);
        return () => window.removeEventListener("message", receive);
      }, [bootstrap, getConnection]);

      useEffect(() => {
        if (!bootstrap || !frameLoaded || !link?.ticketId || !link?.runId) return undefined;
        const publish = () => {
          const observedAt = new Date();
          frameRef.current?.contentWindow?.postMessage({
            type: "vibehub-runtime",
            runtime: running ? {
              trustedSource: "dsh-session-summary",
              ticketId: link.ticketId,
              runId: link.runId,
              operation: "execute",
              state: pending ? "waiting_human" : "running",
              observedAt: observedAt.toISOString(),
              expiresAt: new Date(observedAt.getTime() + 12_000).toISOString(),
            } : null,
          }, new URL(bootstrap.graphUrl).origin);
        };
        publish();
        if (!running) return undefined;
        const interval = setInterval(publish, 5_000);
        return () => clearInterval(interval);
      }, [bootstrap, frameLoaded, link?.ticketId, link?.runId, pending, running]);

      useEffect(() => {
        if (!bootstrap || !frameLoaded) return;
        if (wasRunningRef.current && !running) {
          frameRef.current?.contentWindow?.postMessage({
            type: "vibehub-refresh",
          }, new URL(bootstrap.graphUrl).origin);
        }
        wasRunningRef.current = running;
      }, [bootstrap, frameLoaded, running]);

      return jsxs("section", { className: "vh-dsh-view", children: [
        bootstrap ? jsx("iframe", {
          ref: frameRef,
          className: "vh-dsh-frame",
          src: bootstrap.graphUrl,
          title: "VibeHub Task Workbench",
          onLoad: () => {
            setFrameLoaded(true);
            setStatus(null);
          },
        }) : null,
        onDismiss ? jsx("button", {
          className: "vh-dsh-dismiss",
          type: "button",
          title: "Return to native DSH",
          "aria-label": "Close Tasks and return to native DSH",
          onClick: onDismiss,
          children: "×",
        }) : null,
        status ? jsx("div", {
          className: "vh-dsh-status",
          "data-kind": status.kind,
          role: status.kind === "error" ? "alert" : "status",
          children: status.text,
        }) : null,
      ] });
    }

    function SessionTaskWorkbench({ sessionId, useProjection, useSessions, getSession }) {
      const link = useProjection("vibehubTask");
      return jsx(TaskSurface, {
        getConnection: async () => ({ sessionId, session: getSession() }),
        initialLink: link,
        initialSessionId: sessionId,
        useSessions,
      });
    }

    function GlobalTaskWorkbench({ useSessions, connectWorkspace }) {
      const [open, setOpen] = useState(true);
      return open
        ? jsx("div", { className: "vh-dsh-overlay", children: jsx(TaskSurface, {
          getConnection: connectWorkspace,
          onDismiss: () => setOpen(false),
          useSessions,
        }) })
        : jsx("button", {
          className: "vh-dsh-launcher",
          type: "button",
          onClick: () => setOpen(true),
          children: "Tasks",
        });
    }

    const inject = ["slots", "sessions", "workspaces"];
    function apply(ctx) {
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "vibehub-task-workbench",
        order: 20,
        label: () => "Tasks",
        inject: () => ({
          connectWorkspace: async (repoRoot) => {
            const workspace = await ctx.workspaces.create({ path: repoRoot });
            const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId);
            ctx.sessions.open(sessionId);
            return { sessionId, session: ctx.sessions.binding(sessionId)?.session };
          },
        }),
      }, GlobalTaskWorkbench));

      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "vibehub-tasks",
        order: 20,
        label: () => "Tasks",
        inject: (sessionId) => ({
          getSession: () => ctx.sessions.binding(sessionId)?.session,
        }),
      }, SessionTaskWorkbench));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
