/**
 * Test-server address, overridable via DEMO_PORT so suites can run on a
 * private port while a dev server occupies the default 5199 (loop rule:
 * never kill the human's dev server; use your own port for tests).
 * playwright.config.ts derives its webServer from the same variable.
 */
export const PORT = process.env.DEMO_PORT ?? "5199";
export const BASE = `http://localhost:${PORT}`;
