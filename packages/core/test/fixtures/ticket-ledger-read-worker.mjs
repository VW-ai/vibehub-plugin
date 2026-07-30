import { loadTicketLedgerFromWorktree } from "../../dist/index.js";

try {
  loadTicketLedgerFromWorktree(process.argv[2]);
  process.stdout.write("unexpected-success\n");
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(`${error?.code ?? "unknown"}\n`);
}
