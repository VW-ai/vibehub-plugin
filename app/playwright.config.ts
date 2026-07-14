import { defineConfig } from "@playwright/test";

/**
 * Screenshot-parity harness (S4 gate): boots `vite preview` on the built
 * bundle and captures the React render next to the static v8 reference.
 * DEMO_PORT (default 5199) picks the port — set it when a dev server holds
 * 5199 so test runs never collide with (or reuse) the human's server.
 */
const PORT = process.env.DEMO_PORT ?? "5199";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: `pnpm build:test-harness && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
