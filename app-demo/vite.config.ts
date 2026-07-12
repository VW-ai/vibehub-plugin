import fs from "node:fs";
import { defineConfig, type Plugin, type ViteDevServer } from "vitest/config";

// No @vitejs/plugin-react: dep list is frozen (LOOP.md Tech base). Vite's
// built-in esbuild transform compiles TSX (jsx: react-jsx in tsconfig);
// we only lose React Fast Refresh, which a demo does not need.
//
// Vitest scope: pure-logic unit tests live next to their module in src/
// (*.test.ts). tests/ belongs to Playwright — vitest must never pick those
// specs up (they need a real browser + webServer).

/**
 * M1 ④ real-read path: `/live-fixture.json` is derived FROM SQLITE on every
 * request — the dev-server stand-in for the Tauri shell's read (app reads
 * SQLite via core, decision-project-025); the browser bundle itself never
 * touches the native module.
 *
 * Resolution order, honest at each step:
 *  1. VIBEHUB_DB (or ~/.vibehub/workbench.db) + this repo's snapshot → live
 *  2. no DB / repo never synced → fall through to public/live-fixture.json
 *     (the static export), else 404 → the frontend falls back with a warning.
 * Imports core's BUILT dist so the demo's frozen dep list stays untouched
 * (`pnpm -F @vibehub/core build` first).
 */
function vibehubLiveFixture(): Plugin {
  return {
    name: "vibehub-live-fixture",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/live-fixture.json", (req, res, next) => {
        void (async () => {
          try {
            const core = await import("../packages/core/dist/index.js");
            const dbPath = process.env["VIBEHUB_DB"] ?? core.defaultDbPath();
            if (!fs.existsSync(dbPath)) return next();
            const repoRoot = core.GitFacade.resolveRepoRoot(
              process.env["VIBEHUB_REPO"] ?? process.cwd(),
            );
            const db = core.openDb(dbPath);
            try {
              const fixture = core.exportTeamMapFixture(db, repoRoot);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(fixture));
            } finally {
              db.close();
            }
          } catch {
            next(); // static file or 404 — the frontend handles both honestly
          }
        })();
      });
    },
  };
}

export default defineConfig({
  server: { port: 5199 },
  plugins: [vibehubLiveFixture()],
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
