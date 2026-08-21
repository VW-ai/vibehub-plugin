import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 20_000;

function timeoutError(label, timeoutMs) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

function redactedAccount(result) {
  const account = result?.account;
  if (!account) return { authenticated: false, requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth) };
  return {
    authenticated: true,
    accountType: account.type ?? null,
    planType: account.planType ?? null,
    requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
  };
}

export class CodexAppServerClient extends EventEmitter {
  constructor({
    command = "codex",
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    clientInfo = { name: "vibehub", title: "VibeHub", version: "0.0.0" },
    experimentalApi = true,
  } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.clientInfo = clientInfo;
    this.experimentalApi = experimentalApi;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = [];
    this.child = null;
    this.initialized = null;
  }

  async start() {
    if (this.child) return this.initialized;
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.#receive(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.stderr.push(line);
      this.emit("stderr", line);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${code ?? "null"}, ${signal ?? "none"})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = null;
      this.emit("exit", { code, signal });
    });
    this.initialized = await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: this.experimentalApi,
        requestAttestation: false,
        optOutNotificationMethods: [],
        extensions: {},
      },
    });
    return this.initialized;
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderr.push(line);
      this.emit("stderr", line);
      return;
    }
    if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && Object.hasOwn(message, "id")) {
      this.emit("serverRequest", message);
      return;
    }
    if (message.method) {
      this.notifications.push(message);
      this.emit("notification", message);
      this.emit(`notification:${message.method}`, message.params);
    }
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server is not running");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  waitForNotification(method, predicate = () => true, { timeoutMs = this.timeoutMs } = {}) {
    const prior = this.notifications.find((entry) => entry.method === method && predicate(entry.params));
    if (prior) return Promise.resolve(prior.params);
    return new Promise((resolve, reject) => {
      const event = `notification:${method}`;
      const listener = (params) => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        this.off(event, listener);
        resolve(params);
      };
      const timer = setTimeout(() => {
        this.off(event, listener);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      this.on(event, listener);
    });
  }

  async accountStatus() {
    return redactedAccount(await this.request("account/read", { refreshToken: false }));
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 1_000);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    clearTimeout(timer);
    if (this.child) child.kill("SIGKILL");
    this.child = null;
  }
}

export function projectCodexRuntime({ nextAction, notifications, now = Date.now() }) {
  const latest = [...notifications].reverse().find((entry) =>
    entry.method === "turn/started" || entry.method === "turn/completed");
  if (nextAction === "DONE") return { phase: "DONE", live: false, observedAt: null };
  if (nextAction === "REPLAN" || nextAction === "WAIT" || nextAction === "REFINE") {
    return { phase: "DRAFT", live: false, observedAt: null };
  }
  if (nextAction === "CLOSE_OUT") return { phase: "RUNNING", substate: "VERIFYING", live: false, observedAt: null };
  if (latest?.method === "turn/started") return { phase: "RUNNING", substate: null, live: true, observedAt: now };
  return { phase: "READY", live: false, observedAt: null };
}
