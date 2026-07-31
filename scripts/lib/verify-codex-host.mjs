import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export async function verifyCodexHostStartsMcp(
  codexBin,
  env,
  repo,
  { timeoutMs = 20_000 } = {},
) {
  const child = spawn(codexBin, ["app-server", "--stdio"], {
    cwd: repo,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = [];
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout });
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const resultPromise = new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Codex app-server did not report VibeHub MCP ready within ${timeoutMs}ms\n${output.join("\n")}\n${stderr}`,
          ),
        ),
      );
    }, timeoutMs);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      callback();
    };

    lines.on("line", (line) => {
      output.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0 && message.error) {
        finish(() =>
          reject(new Error(`Codex app-server initialize failed: ${line}`)),
        );
        return;
      }
      if (message.id === 1 && message.error) {
        finish(() =>
          reject(new Error(`Codex thread/start failed: ${line}`)),
        );
        return;
      }
      if (
        message.method === "mcpServer/startupStatus/updated" &&
        message.params?.name === "vibehub"
      ) {
        if (message.params.status === "ready") {
          finish(() => resolve(message.params));
        } else if (message.params.status === "failed") {
          finish(() =>
            reject(
              new Error(
                `Codex host failed to start VibeHub MCP: ${JSON.stringify(message.params)}\n${output.join("\n")}\n${stderr}`,
              ),
            ),
          );
        }
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (code !== null || signal !== "SIGTERM") {
        finish(() =>
          reject(
            new Error(
              `Codex app-server exited before VibeHub MCP became ready (${code ?? signal})\n${stderr}`,
            ),
          ),
        );
      }
    });

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: {
          name: "vibehub_plugin_verifier",
          title: "VibeHub Plugin Verifier",
          version: "0.1.0",
        },
      },
    });
    send({ method: "initialized", params: {} });
    send({
      method: "thread/start",
      id: 1,
      params: { model: "gpt-5.4", cwd: repo },
    });
  });
  try {
    return await resultPromise;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  }
}
