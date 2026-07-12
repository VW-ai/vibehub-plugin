import { defineConfig } from "vitest/config";

// No @vitejs/plugin-react: dep list is frozen (LOOP.md Tech base). Vite's
// built-in esbuild transform compiles TSX (jsx: react-jsx in tsconfig);
// we only lose React Fast Refresh, which a demo does not need.
//
// Vitest scope: pure-logic unit tests live next to their module in src/
// (*.test.ts). tests/ belongs to Playwright — vitest must never pick those
// specs up (they need a real browser + webServer).
export default defineConfig({
  server: { port: 5199 },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
