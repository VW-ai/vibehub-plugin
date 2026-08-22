import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_TIMEOUT_MS = 20_000;
const METHOD_NOT_FOUND = -32601;

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

// One client owns at most one `codex app-server` child at a time. Every
// spawn is a new process generation: replies, notifications and waiters that
// belong to an earlier generation are settled when that process goes away and
// never answer for the next one.
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
    this.generation = 0;
    this.starting = null;
    this.stopRequested = null;
    this.waiters = new Set();
  }

  get alive() {
    return Boolean(this.child?.stdin?.writable);
  }

  start() {
    if (this.child) return this.starting ?? Promise.resolve(this.initialized);
    this.starting = this.#spawn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  // Stop the current process (if any) and spawn the next generation.
  async restart() {
    await this.stop();
    return this.start();
  }

  async #spawn() {
    const generation = this.generation + 1;
    // A respawn starts from a clean slate: nothing observed from the previous
    // process can satisfy a request or a wait against the new one.
    this.pending.clear();
    this.notifications = [];
    this.stderr = [];
    this.initialized = null;
    const child = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.generation = generation;
    // A write that races the child's death surfaces through the exit path,
    // not as an unhandled stream error.
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child === child) this.#receive(line);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (this.child !== child) return;
      this.stderr.push(line);
      this.emit("stderr", line);
    });
    child.once("error", (error) => this.#gone(child, { code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => this.#gone(child, { code, signal }));
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

  #gone(child, { code, signal, error: spawnError = null }) {
    if (this.child !== child) return;
    const diagnostic = this.stderr.slice(-3).join("\n");
    const error = new Error(`codex app-server exited (${code ?? "null"}, ${signal ?? "none"})${spawnError ? `: ${spawnError}` : ""}${diagnostic ? `:\n${diagnostic}` : ""}`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
    const requested = this.stopRequested === child;
    this.stopRequested = null;
    this.child = null;
    this.emit("exit", { code, signal, generation: this.generation, requested, error: spawnError });
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
      if (message.error) {
        // A pinned request the runtime does not know is a stop condition, so
        // it is announced before the caller sees the rejection.
        if (message.error.code === METHOD_NOT_FOUND) {
          this.emit("methodMissing", { method: pending.method, generation: this.generation, error: message.error });
        }
        pending.reject(Object.assign(new Error(message.error.message), { rpcError: message.error, method: pending.method }));
      } else pending.resolve(message.result);
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
      this.pending.set(String(id), { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  respond(id, result) {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  respondError(id, code, message) {
    if (!this.child?.stdin?.writable) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }

  // Resolves with the first matching notification of the current process
  // generation. Notifications observed before a restart never match, and a
  // wait that is still open when the process exits is rejected.
  waitForNotification(method, predicate = () => true, { timeoutMs = this.timeoutMs } = {}) {
    const prior = this.notifications.find((entry) => entry.method === method && predicate(entry.params));
    if (prior) return Promise.resolve(prior.params);
    return new Promise((resolve, reject) => {
      const event = `notification:${method}`;
      const generation = this.generation;
      const waiter = { reject: (error) => { cleanup(); reject(error); } };
      const listener = (params) => {
        if (this.generation !== generation || !predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.off(event, listener);
        this.waiters.delete(waiter);
      };
      this.waiters.add(waiter);
      this.on(event, listener);
    });
  }

  async accountStatus() {
    return redactedAccount(await this.request("account/read", { refreshToken: false }));
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.stopRequested = child;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 1_000);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    clearTimeout(timer);
    if (this.child === child) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (this.child === child) this.#gone(child, { code: null, signal: "SIGKILL" });
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
