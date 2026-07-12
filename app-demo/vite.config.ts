import { defineConfig } from "vite";

// No @vitejs/plugin-react: dep list is frozen (LOOP.md Tech base). Vite's
// built-in esbuild transform compiles TSX (jsx: react-jsx in tsconfig);
// we only lose React Fast Refresh, which a demo does not need.
export default defineConfig({
  server: { port: 5199 },
});
