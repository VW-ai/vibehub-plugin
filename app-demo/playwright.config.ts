import { defineConfig } from "@playwright/test";

/**
 * Screenshot-parity harness (S4 gate): boots `vite preview` on the built
 * bundle and captures the React render next to the static v8 reference.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 5199 --strictPort",
    url: "http://localhost:5199",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
