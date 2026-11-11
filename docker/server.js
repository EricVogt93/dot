#!/usr/bin/env node
/**
 * Dot container HTTP bridge.
 *
 * Translates OpenAI-compatible chat requests into turns on a long-lived
 * `codex app-server` child process (newline-delimited JSON-RPC 2.0 over stdio)
 * and exposes remote-control pairing and environment status.
 *
 * Zero npm dependencies.
 */
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CODEX_BIN =
  process.env.CODEX_BIN ||
  "/data/codex/packages/standalone/current/bin/codex";
const CODEX_HOME = process.env.CODEX_HOME || "/data/codex";
const WORKSPACE = path.resolve(process.env.DOT_WORKSPACE || "/workspace");
const PORT = Number(process.env.DOT_API_PORT || 8787);
const BIND = process.env.DOT_BIND || "127.0.0.1";
const API_KEY = process.env.DOT_API_KEY || "";
const MODEL = process.env.DOT_MODEL || null;
const SANDBOX = process.env.DOT_SANDBOX || "danger-full-access";
const APPROVAL_POLICY = process.env.DOT_APPROVAL_POLICY || "never";
const THREAD_MODE =
  process.env.DOT_THREAD_MODE === "ephemeral" ? "ephemeral" : "persistent";
const TURN_TIMEOUT_MS = Number(process.env.DOT_TURN_TIMEOUT_MS || 600_000);
const CHATGPT_BASE_URL = (
  process.env.DOT_CHATGPT_BASE_URL || "https://chatgpt.com/backend-api"
).replace(/\/+$/, "");

// Comma-separated browser origins allowed to call the API (CORS). Empty means
// no cross-origin access; "*" allows any origin and requires DOT_API_KEY.
const CORS_ORIGINS = String(process.env.DOT_CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Opt-in: pass --analytics-default-enabled to the app-server.
const ANALYTICS = process.env.DOT_ANALYTICS === "1";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CMD_OUTPUT_BYTES = 256 * 1024;
const MAX_RPC_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_CONVERSATIONS = 1000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const PACKAGE_VERSION = await readFile(
  new URL("./package.json", import.meta.url),
  "utf8",
)
  .then((raw) => JSON.parse(raw).version || "0.0.0")
  .catch(() => "0.0.0");

// ---------------------------------------------------------------------------
// Small utilities & HTTP helpers
// ---------------------------------------------------------------------------

function log(message, extra) {
  const line = `[dot-api] ${new Date().toISOString()} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function errorMessage(error, fallback = "internal error") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return String(error.message || error);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function authorized(req, url, apiKey = API_KEY) {
  if (!apiKey) return true;
  if (url.pathname === "/health") return true;
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && safeEqual(match[1], apiKey));
}

/**
 * Without an API key the bridge relies on being reachable only from loopback.
 * Reject non-loopback Host headers in that mode to block DNS-rebinding attacks
 * from web pages opened on the same machine.
 */
function hostAllowed(req, apiKey = API_KEY) {
  if (apiKey) return true;
  const host = String(req.headers.host || "").trim();
  if (!host) return false;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return false;
    return LOOPBACK_HOSTS.has(host.slice(0, end + 1).toLowerCase());
  }
  const [name] = host.split(":");
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

function allowedOrigin(origin, origins = CORS_ORIGINS, apiKey = API_KEY) {
  if (!origin) return null;
  if (origins.includes("*") && apiKey) return "*";
  return origins.includes(origin) ? origin : null;
}

function isJsonRequest(req) {
  const type = String(req.headers["content-type"] || "").toLowerCase();
  return type.split(";")[0].trim() === "application/json";
}

async function readJsonBody(req) {
  const declaredLength = Number(req.headers["content-length"] || 0);
  if (declaredLength > MAX_BODY_BYTES) {
    throw httpError(413, "Request body too large");
  }
  const hasBody =
    declaredLength > 0 || Boolean(req.headers["transfer-encoding"]);
  if (hasBody && !isJsonRequest(req)) {
    throw httpError(415, "Content-Type must be application/json");
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw httpError(413, "Request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  if (!isJsonRequest(req)) {
    throw httpError(415, "Content-Type must be application/json");
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(400, "Request body must be a JSON object");
    }
    return parsed;
  } catch (error) {
    if (error.statusCode) throw error;
    throw httpError(400, "Request body is not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Codex CLI & App-Server JSON-RPC client
// ---------------------------------------------------------------------------

function runCodex(args, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      env: { ...process.env, CODEX_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex ${args.join(" ")} timed out`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CMD_OUTPUT_BYTES) {
        stdout += chunk.slice(0, MAX_CMD_OUTPUT_BYTES - stdout.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CMD_OUTPUT_BYTES) {
        stderr += chunk.slice(0, MAX_CMD_OUTPUT_BYTES - stderr.length);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`codex ${args.join(" ")} exited ${code}: ${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseLastJson(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning upwards: remote-control prints event lines before JSON.
    }
  }
  throw new Error("no JSON object found in command output");
}

class AppServer {
  constructor({ onReset } = {}) {
    this.onReset = onReset || (() => {});
    this.child = null;
    this.initialized = false;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.starting = null;
    this.shuttingDown = false;
    this.restartDelay = 1000;
    this.restartTimer = null;
  }

  async start() {
    if (this.child && this.initialized) return;
    if (this.starting) return this.starting;
    this.starting = this._spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _spawnAndInitialize() {
    const args = [
      "app-server",
      "--listen",
      "stdio://",
      ...(ANALYTICS ? ["--analytics-default-enabled"] : []),
    ];
    const child = spawn(CODEX_BIN, args, {
      env: { ...process.env, CODEX_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    this.child = child;
    this.initialized = false;
    this.buffer = "";

    child.stdout.on("data", (chunk) => this._onData(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) log(`app-server stderr: ${text.slice(-2000)}`);
    });
    child.on("error", (error) => {
      log(`app-server spawn error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      log(`app-server exited code=${code} signal=${signal}`);
      if (this.child === child) {
        this.child = null;
        this.initialized = false;
        this.buffer = "";
      }
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("app-server exited"));
      }
      this.pending.clear();
      this.onReset();
      this._emit("server/exited", { code, signal });
      this._scheduleRestart();
    });

    try {
      const response = await this.request(
        "initialize",
        {
          clientInfo: {
            name: "dot-container",
            title: "Dot Container",
            version: PACKAGE_VERSION,
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
        30_000,
        true,
      );
      this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.initialized = true;
      this.restartDelay = 1000;
      this.onReset();
      log(`app-server initialized: ${response.userAgent}`);
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        this.initialized = false;
        this.buffer = "";
      }
      child.kill("SIGKILL");
      throw error;
    }
  }

  _scheduleRestart() {
    if (this.shuttingDown || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30_000);
    log(`restarting app-server in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((error) => {
        log(`app-server restart failed: ${error.message}`);
      });
    }, delay);
  }

  _send(message) {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("app-server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _onData(chunk) {
    this.buffer += chunk;
    let start = 0;
    let index = this.buffer.indexOf("\n", start);
    while (index >= 0) {
      const line = this.buffer.slice(start, index).trim();
      start = index + 1;
      if (line) this._onLine(line);
      index = this.buffer.indexOf("\n", start);
    }
    if (start > 0) {
      this.buffer = this.buffer.slice(start);
    }
    if (this.buffer.length > MAX_RPC_BUFFER_BYTES) {
      log(
        `dropping oversized app-server line (${this.buffer.length} bytes > ${MAX_RPC_BUFFER_BYTES})`,
      );
      this.buffer = "";
    }
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log(`non-JSON app-server output: ${line.slice(0, 500)}`);
      return;
    }

    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new Error(
          message.error.message || "app-server request failed",
        );
        error.rpc = message.error;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this._replyToServerRequest(message);
      return;
    }

    if (message.method) {
      this._emit(message.method, message.params || {});
    }
  }

  _emit(method, params) {
    const handlers = this.listeners.get(method);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        log(`notification handler for ${method} failed: ${error.message}`);
      }
    }
  }

  _replyToServerRequest(message) {
    const { id, method } = message;
    let response;
    if (
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      response = { jsonrpc: "2.0", id, result: { decision: "approved" } };
    } else if (method === "fileChangeRequestApproval") {
      response = { jsonrpc: "2.0", id, result: { decision: "accept" } };
    } else if (method === "toolRequestUserInput") {
      response = { jsonrpc: "2.0", id, result: { answers: {} } };
    } else if (method === "permissionsRequestApproval") {
      // The container grants the sandbox it was started with; deny ad-hoc
      // permission escalations instead of silently widening it.
      response = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "permission escalation unsupported" },
      };
    } else {
      response = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `unsupported server request: ${method}` },
      };
    }
    try {
      this._send(response);
    } catch (error) {
      log(`failed replying to ${method}: ${error.message}`);
    }
  }

  on(method, handler) {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.listeners.delete(method);
    };
  }

  async request(method, params, timeoutMs = 30_000, allowBeforeInit = false) {
    if (!allowBeforeInit) {
      await this.start();
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async stop() {
    this.shuttingDown = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Conversation & Turn management
// ---------------------------------------------------------------------------

const conversations = new Map(); // conversationId -> {threadId, developerInstructions, model, queue}
const pendingThreads = new Map(); // conversationId -> Promise<entry>
const activeTurns = new Map(); // threadId -> turnId

const appServer = new AppServer({
  onReset() {
    conversations.clear();
    pendingThreads.clear();
    activeTurns.clear();
  },
});

function validateCwd(requested) {
  if (!requested) return WORKSPACE;
  if (typeof requested !== "string" || requested.includes("\0")) {
    throw httpError(400, "cwd must be a valid path string");
  }
  const resolved = path.resolve(requested);
  const root = WORKSPACE.endsWith(path.sep) ? WORKSPACE : WORKSPACE + path.sep;
  if (resolved !== WORKSPACE && !resolved.startsWith(root)) {
    throw httpError(400, `cwd must be inside ${WORKSPACE}`);
  }
  return resolved;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (part && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else {
        throw httpError(400, "Only text content parts are supported by this bridge");
      }
    }
    return parts.join("\n");
  }
  return "";
}

function normalizeMessages(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const system = [];
  let lastUser = "";
  for (const message of messages) {
    const role = message && message.role;
    const text = contentToText(message && message.content);
    if (role === "system" || role === "developer") system.push(text);
    else if (role === "user") lastUser = text;
  }
  if (!lastUser && typeof body.input === "string") lastUser = body.input;
  if (!lastUser && typeof body.prompt === "string") lastUser = body.prompt;
  if (!lastUser) {
    throw httpError(400, "at least one user message is required");
  }
  return { system: system.filter(Boolean).join("\n\n"), lastUser };
}

function conversationIdFor(body, req) {
  return String(
    body.conversation_id ||
      (body.metadata && body.metadata.conversation_id) ||
      req.headers["x-conversation-id"] ||
      body.user ||
      "default",
  );
}

function evictOldestConversations() {
  if (conversations.size < MAX_CONVERSATIONS) return;
  for (const [key, entry] of conversations) {
    if (conversations.size < MAX_CONVERSATIONS) break;
    if (activeTurns.has(entry.threadId)) continue;
    conversations.delete(key);
  }
}

async function createThread(conversationId, body) {
  const { system } = normalizeMessages(body);
  const cwd = validateCwd(body.cwd);
  const params = {
    cwd,
    ephemeral: THREAD_MODE === "ephemeral",
    approvalPolicy: APPROVAL_POLICY,
    sandbox: SANDBOX,
  };
  const model = body.model || MODEL;
  if (model) params.model = model;
  if (system) params.developerInstructions = system;

  const response = await appServer.request("thread/start", params, 60_000);
  const threadId = response?.thread?.id;
  if (!threadId) throw new Error("thread/start returned no thread id");

  const entry = {
    threadId,
    developerInstructions: system,
    model: model || null,
    queue: Promise.resolve(),
  };
  if (THREAD_MODE !== "ephemeral") {
    evictOldestConversations();
    conversations.set(conversationId, entry);
  }
  log(`created thread ${threadId} for conversation ${conversationId}`);
  return entry;
}

async function getThread(conversationId, body) {
  if (THREAD_MODE === "ephemeral") {
    return createThread(conversationId, body);
  }
  const existing = conversations.get(conversationId);
  if (existing) {
    // Refresh insertion order for LRU eviction.
    conversations.delete(conversationId);
    conversations.set(conversationId, existing);
    return existing;
  }
  const inflight = pendingThreads.get(conversationId);
  if (inflight) return inflight;

  const promise = createThread(conversationId, body).finally(() => {
    pendingThreads.delete(conversationId);
  });
  pendingThreads.set(conversationId, promise);
  return promise;
}

function runTurn(entry, body, onDelta, signal, { accumulateText = true } = {}) {
  const { lastUser } = normalizeMessages(body);
  const run = async () => {
    let turnId = null;
    let delivered = "";
    let hasDelivered = false;
    let finished = false;
    let aborted = false;
    let timer = null;
    let resolveFinish;
    const finishedPromise = new Promise((resolve) => {
      resolveFinish = resolve;
    });

    const unsubscribers = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const off of unsubscribers) off();
      unsubscribers.length = 0;
      if (signal) signal.removeEventListener("abort", onAbort);
      if (turnId && activeTurns.get(entry.threadId) === turnId) {
        activeTurns.delete(entry.threadId);
      }
    };

    const done = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolveFinish({ error: error || null });
    };

    function onAbort() {
      aborted = true;
      if (!turnId) return; // interrupt after turn/start returns
      appServer
        .request("turn/interrupt", { threadId: entry.threadId, turnId }, 10_000)
        .catch(() => {});
      done(new Error("client disconnected"));
    }

    // Subscribe before turn/start: a fast turn can complete before the RPC
    // response is processed.
    unsubscribers.push(
      appServer.on("item/agentMessage/delta", (params) => {
        if (params.threadId !== entry.threadId) return;
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (typeof params.delta === "string") {
          hasDelivered = true;
          if (accumulateText) delivered += params.delta;
          onDelta(params.delta);
        }
      }),
      appServer.on("turn/completed", (params) => {
        if (params.threadId !== entry.threadId) return;
        const completed = params.turn || {};
        if (turnId && completed.id && completed.id !== turnId) return;
        if (!turnId && completed.id) turnId = completed.id;
        if (!completed.error && !hasDelivered) {
          const items = Array.isArray(completed.items) ? completed.items : [];
          for (const item of items) {
            if (item && item.type === "agentMessage" && item.text) {
              hasDelivered = true;
              if (accumulateText) delivered += item.text;
              onDelta(item.text);
            }
          }
        }
        done(completed.error || null);
      }),
      appServer.on("error", (params) => {
        if (params?.threadId && params.threadId !== entry.threadId) return;
        if (turnId && params?.turnId && params.turnId !== turnId) return;
        done(new Error(params?.message || params?.error || "turn failed"));
      }),
      appServer.on("server/exited", () => {
        done(new Error("app-server exited during turn"));
      }),
    );

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let response;
    try {
      response = await appServer.request(
        "turn/start",
        {
          threadId: entry.threadId,
          input: [{ type: "text", text: lastUser }],
        },
        60_000,
      );
    } catch (error) {
      done(error);
      throw error;
    }

    const startedTurnId = response?.turn?.id;
    if (!turnId) turnId = startedTurnId || null;
    if (!finished) {
      if (turnId) activeTurns.set(entry.threadId, turnId);
      timer = setTimeout(() => {
        appServer
          .request(
            "turn/interrupt",
            { threadId: entry.threadId, turnId },
            10_000,
          )
          .catch(() => {});
        done(new Error(`turn timed out after ${TURN_TIMEOUT_MS}ms`));
      }, TURN_TIMEOUT_MS);
    }
    if (aborted && !finished) {
      onAbort();
    }

    const result = await finishedPromise;
    return { turnId, error: result.error, text: delivered };
  };

  // Serialize turns for the same thread; discard resolved payload on entry.queue
  // so idle conversations do not retain the previous turn's response text.
  const queued = entry.queue.then(run, run);
  entry.queue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

// ---------------------------------------------------------------------------
// State readers
// ---------------------------------------------------------------------------

async function readInstallationId() {
  try {
    const raw = await readFile(path.join(CODEX_HOME, "installation_id"), "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

async function readAuth() {
  try {
    const raw = await readFile(path.join(CODEX_HOME, "auth.json"), "utf8");
    const data = JSON.parse(raw);
    const tokens = data.tokens || {};
    return {
      loggedIn: data.auth_mode === "chatgpt" || Boolean(data.OPENAI_API_KEY),
      authMode: data.auth_mode || (data.OPENAI_API_KEY ? "apiKey" : null),
      accountId: tokens.account_id || null,
      accessToken: tokens.access_token || null,
      apiKey: data.OPENAI_API_KEY || null,
    };
  } catch {
    return {
      loggedIn: false,
      authMode: null,
      accountId: null,
      accessToken: null,
      apiKey: null,
    };
  }
}

async function readRemoteStatus() {
  try {
    const raw = await readFile(
      path.join(CODEX_HOME, "dot-remote-status.json"),
      "utf8",
    );
    const data = JSON.parse(raw);
    return {
      connected: data.status === "connected",
      status: data.status || "unknown",
      serverName: data.serverName || null,
      environmentId: data.environmentId || null,
    };
  } catch {
    // Fall through to the daemon check.
  }
  try {
    const { stdout } = await runCodex(["app-server", "daemon", "version"], 5000);
    const data = JSON.parse(stdout.trim());
    return {
      connected:
        data.status === "running" && data.appServerVersion === data.cliVersion,
      status: data.status === "running" ? "running" : data.status || "unknown",
      serverName: null,
      environmentId: null,
    };
  } catch (error) {
    return {
      connected: false,
      status: "unknown",
      serverName: null,
      environmentId: null,
      error: error.message,
    };
  }
}

let cachedVersion = null;
async function codexVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const { stdout } = await runCodex(["--version"], 5000);
    const version = stdout.trim();
    if (version) {
      cachedVersion = version;
      return version;
    }
    return "unknown";
  } catch {
    return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleChatCompletions(req, res, body) {
  const conversationId = conversationIdFor(body, req);
  const entry = await getThread(conversationId, body);
  const model = body.model || entry.model || MODEL || "codex";
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const write = (payload) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta, finishReason = null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    write(chunk({ role: "assistant", content: "" }));
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 15_000);
    const controller = new AbortController();
    const onClose = () => controller.abort();
    res.on("close", onClose);

    try {
      const result = await runTurn(
        entry,
        body,
        (delta) => write(chunk({ content: delta })),
        controller.signal,
        { accumulateText: false },
      );
      if (result.error) {
        write({ error: { message: errorMessage(result.error) } });
      } else {
        write(chunk({}, "stop"));
      }
    } catch (error) {
      write({ error: { message: errorMessage(error) } });
    } finally {
      clearInterval(ping);
      res.off("close", onClose);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  const result = await runTurn(entry, body, () => {});
  if (result.error) {
    throw httpError(502, errorMessage(result.error));
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    conversation_id: conversationId,
    thread_id: entry.threadId,
  });
}

async function handleSimpleChat(req, res, body) {
  const conversationId = conversationIdFor(body, req);
  const entry = await getThread(conversationId, body);
  const result = await runTurn(entry, body, () => {});
  if (result.error) {
    throw httpError(502, errorMessage(result.error));
  }
  sendJson(res, 200, {
    reply: result.text,
    thread_id: entry.threadId,
    conversation_id: conversationId,
  });
}

async function handleHealth(req, res) {
  const [auth, remote, version, installationId] = await Promise.all([
    readAuth(),
    readRemoteStatus(),
    codexVersion(),
    readInstallationId(),
  ]);
  sendJson(res, 200, {
    ok: true,
    codex: { version, bin: CODEX_BIN },
    auth: {
      loggedIn: auth.loggedIn,
      authMode: auth.authMode,
      accountIdPresent: Boolean(auth.accountId),
    },
    remote: { ...remote, installationId },
    workspace: WORKSPACE,
    model: MODEL,
  });
}

async function handleRemoteEnvironments(req, res) {
  const [auth, installationId] = await Promise.all([
    readAuth(),
    readInstallationId(),
  ]);
  if (!auth.accessToken) {
    sendJson(res, 401, {
      error: "No ChatGPT access token in auth.json; run device login first.",
    });
    return;
  }
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "codex-cli/dot-container",
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;

  try {
    const response = await fetch(
      `${CHATGPT_BASE_URL}/wham/remote/control/environments`,
      { headers, signal: AbortSignal.timeout(15_000) },
    );
    const text = await response.text();
    if (!response.ok) {
      sendJson(res, 502, {
        error: `environment list failed (${response.status})`,
        detail: text.slice(0, 2000),
      });
      return;
    }
    const data = JSON.parse(text);
    const items = Array.isArray(data.items) ? data.items : [];
    const self =
      items.find(
        (item) =>
          installationId && item.installation_id === installationId,
      ) || null;
    sendJson(res, 200, { self, items });
  } catch (error) {
    sendJson(res, 502, { error: errorMessage(error) });
  }
}

async function handlePair(req, res) {
  try {
    const { stdout } = await runCodex(
      ["remote-control", "pair", "--json"],
      15_000,
    );
    sendJson(res, 200, parseLastJson(stdout));
  } catch (error) {
    sendJson(res, 502, { error: errorMessage(error) });
  }
}

async function handleInterrupt(req, res, body) {
  const threadId = body.thread_id || body.threadId;
  if (!threadId || typeof threadId !== "string") {
    throw httpError(400, "thread_id is required");
  }
  const turnId = activeTurns.get(threadId);
  if (!turnId) {
    throw httpError(404, "no active turn for that thread");
  }
  await appServer.request("turn/interrupt", { threadId, turnId }, 10_000);
  sendJson(res, 200, { ok: true, thread_id: threadId, turn_id: turnId });
}

// ---------------------------------------------------------------------------
// HTTP server & lifecycle
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (!hostAllowed(req)) {
      sendJson(res, 403, {
        error:
          "non-loopback Host header rejected; set DOT_API_KEY to allow remote access",
      });
      return;
    }

    const origin = req.headers.origin;
    const corsOrigin = allowedOrigin(origin);
    if (origin && !corsOrigin) {
      // Browsers attach Origin to cross-site requests. Refuse them unless the
      // origin is explicitly allowed, so a web page cannot drive the agent.
      sendJson(res, 403, { error: "origin not allowed" });
      return;
    }
    if (corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, X-Conversation-Id",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    if (!authorized(req, url)) {
      sendJson(res, 401, { error: "invalid or missing API key" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      await handleHealth(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const model = MODEL || "codex";
      sendJson(res, 200, {
        object: "list",
        data: [{ id: model, object: "model", owned_by: "openai" }],
      });
      return;
    }
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" ||
        url.pathname === "/chat/completions")
    ) {
      const body = await readJsonBody(req);
      await handleChatCompletions(req, res, body);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/chat") {
      const body = await readJsonBody(req);
      await handleSimpleChat(req, res, body);
      return;
    }
    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/v1/remote/pair"
    ) {
      await handlePair(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/remote/environments") {
      await handleRemoteEnvironments(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/interrupt") {
      const body = await readJsonBody(req);
      await handleInterrupt(req, res, body);
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    if (error.statusCode === 413) {
      res.setHeader("Connection", "close");
    }
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, { error: errorMessage(error) });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

async function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close();
  await appServer.stop();
  process.exit(0);
}

function start() {
  if (CORS_ORIGINS.includes("*") && !API_KEY) {
    log('DOT_CORS_ORIGINS="*" ignored because DOT_API_KEY is not set');
  }
  if (!API_KEY && !LOOPBACK_HOSTS.has(BIND)) {
    log(
      `WARNING: listening on ${BIND} without DOT_API_KEY; only loopback Host headers are accepted`,
    );
  }
  server.listen(PORT, BIND, () => {
    log(`listening on ${BIND}:${PORT} workspace=${WORKSPACE} codex=${CODEX_BIN}`);
    appServer.start().catch((error) => {
      log(`initial app-server start failed: ${error.message}`);
    });
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) start();

export {
  allowedOrigin,
  authorized,
  contentToText,
  conversationIdFor,
  hostAllowed,
  normalizeMessages,
  parseLastJson,
  server,
  start,
  validateCwd,
};
