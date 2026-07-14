import type { InstallStep } from "@vibehub/core/contracts";

/** Product install manifest; statuses are initialized before the CLI runs. */
export const PRISTINE_INSTALL_STEPS: InstallStep[] = [
  { id: "hooks", label: "Installs hooks for Claude Code", status: "pending" },
  { id: "mcp", label: "Registers the MCP server", status: "pending" },
  { id: "db", label: "Creates a local database", status: "pending" },
];
