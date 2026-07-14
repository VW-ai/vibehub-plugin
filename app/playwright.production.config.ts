import { defineConfig } from "@playwright/test";

const PORT = process.env.PRODUCTION_E2E_PORT ?? "5201";

export default defineConfig({
  testDir: "./tests-production",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT}`,
    port: Number(PORT),
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
