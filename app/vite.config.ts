import { defineConfig, type Plugin, type ViteDevServer } from "vitest/config";
import type { WorkbenchRepoRef } from "@vibehub/core/contracts";
import { resolveWorkbenchRepoRef } from "@vibehub/core";
import { dispatchWorkbenchEnvelope } from "./src/development-bridge";

/**
 * Production safety gate: canned scenarios belong to the browser test harness,
 * never to the shipped entry graph. Rollup exposes the resolved module graph at
 * bundle time, so this check cannot be bypassed by a renamed output chunk.
 */
function forbidProductionFixtures(): Plugin {
  return {
    name: "forbid-production-fixtures",
    generateBundle(_options, bundle) {
      const forbidden = Object.values(bundle)
        .filter((item) => item.type === "chunk")
        .flatMap((item) => Object.keys(item.modules))
        .filter((id) => /[/\\](?:fixtures|test)[/\\]/.test(id));

      if (forbidden.length > 0) {
        this.error(
          `production entry imports test fixtures:\n${forbidden.join("\n")}`,
        );
      }
    },
  };
}

// No @vitejs/plugin-react: dep list is frozen (LOOP.md Tech base). Vite's
// built-in esbuild transform compiles TSX (jsx: react-jsx in tsconfig);
// we only lose React Fast Refresh, which a demo does not need.
//
// Vitest scope: pure-logic unit tests live next to their module in src/
// (*.test.ts). tests/ belongs to Playwright — vitest must never pick those
// specs up (they need a real browser + webServer).

function readBody(req: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("request too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/** Loopback-only dev/test/dogfood host. Production builds do not install it. */
function vibehubDevelopmentBridge(repo: WorkbenchRepoRef | null): Plugin {
  return {
    name: "vibehub-development-bridge",
    transformIndexHtml(html) {
      if (!repo) return html;
      const config = JSON.stringify({
        endpoint: "/__vibehub/workbench",
        repo,
      }).replaceAll("<", "\\u003c");
      return html.replace(
        "</head>",
        `<script>window.__VIBEHUB_WORKBENCH_HOST__=${config}</script></head>`,
      );
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/__vibehub/workbench", (req, res) => {
        void (async () => {
          try {
            if (!repo) {
              throw new Error("VIBEHUB_REPO is required");
            }
            const envelope = await readBody(req);
            const core = await import("../packages/core/dist/index.js");
            const service = new core.RuntimeService();
            const result = dispatchWorkbenchEnvelope(envelope, repo, service);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(result));
          } catch (error) {
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                status: "internal_error",
                message:
                  error instanceof Error
                    ? `Development bridge failed: ${error.message}`
                    : "Development bridge failed.",
              }),
            );
          }
        })();
      });
    },
  };
}

function testHarnessEntry(): Plugin {
  return {
    name: "test-harness-entry",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html.replace("/src/main.tsx", "/test/harness-main.tsx");
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const testHarness = mode === "test-harness";
  const development = mode === "development";
  const configuredRepo = process.env["VIBEHUB_REPO"];
  const repo = configuredRepo
    ? resolveWorkbenchRepoRef(
        configuredRepo,
        process.env["VIBEHUB_REPO_KEY"],
      )
    : null;
  return {
    server: { host: "127.0.0.1", port: 5199 },
    plugins: testHarness
      ? [testHarnessEntry()]
      : development
        ? [forbidProductionFixtures(), vibehubDevelopmentBridge(repo)]
        : [forbidProductionFixtures()],
    test: {
      include: ["test/unit/**/*.test.ts"],
      environment: "node",
    },
  };
});
