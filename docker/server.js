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
  if (url.pathname === "/health" || url.pathname === "/livez" || url.pathname === "/readyz") {
    return true;
  }
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
  constructor({ onInvalidate } = {}) {
    this.onInvalidate = onInvalidate || (() => {});
    this.child = null;
    this.generation = 0; // monotonic per spawn; old events must not touch new state
    this.initialized = false;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer, generation}
    this.listeners = new Map();
    this.starting = null;
    this.shuttingDown = false;
    this.restartDelay = 1000;
    this.restartTimer = null;
  }

  async start() {
    if (this.shuttingDown) throw httpError(502, "app-server is shutting down");
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
    const generation = ++this.generation;
    let child;
    try {
      child = spawn(CODEX_BIN, args, {
        env: { ...process.env, CODEX_HOME },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      // spawn can throw synchronously; no exit event is guaranteed then.
      throw httpError(502, `app-server spawn failed: ${error.message}`);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    this.child = child;
    this.initialized = false;
    this.buffer = "";
    this.nextId = 1;

    const ownsChild = () => this.child === child && this.generation === generation;
    child.stdout.on("data", (chunk) => {
      if (ownsChild()) this._onData(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.trim();
      if (text) log(`app-server stderr: ${text.slice(-2000)}`);
    });
    child.stdin.on("error", (error) => {
      if (ownsChild()) {
        this._invalidate(child, httpError(502, `app-server stdin error: ${error.message}`));
      }
    });
    child.on("error", (error) => {
      this._invalidate(child, httpError(502, `app-server spawn error: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (!ownsChild()) return; // stale exit of an already replaced child
      log(`app-server exited code=${code} signal=${signal}`);
      this._invalidate(child, httpError(502, "app-server exited"));
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
        generation,
      );
      if (!ownsChild()) throw httpError(502, "app-server exited during initialization");
      this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
      this.initialized = true;
      this.restartDelay = 1000;
      log(`app-server initialized: ${response.userAgent}`);
      cacheVersionAtStart().catch(() => {});
    } catch (error) {
      this._invalidate(child, error);
      throw error;
    }
  }

  // Single invalidation path: only the currently owned child, only once.
  // Rejects pending RPCs, drops parser state, invalidates thread owners,
  // emits server/exited, kills the child if needed and schedules a restart.
  _invalidate(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.buffer = "";
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(failure);
    }
    this.pending.clear();
    this.onInvalidate(this.generation);
    this._emit("server/exited", { message: failure.message });
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
    this._scheduleRestart();
  }

  // Invalidate the current child from outside (unrecoverable turn states).
  invalidate(error) {
    if (this.child) this._invalidate(this.child, error);
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
      throw httpError(502, "app-server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && this.child === child) {
        this._invalidate(child, httpError(502, `app-server write failed: ${error.message}`));
      }
    });
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
        `oversized app-server line (${this.buffer.length} bytes > ${MAX_RPC_BUFFER_BYTES}); invalidating`,
      );
      this.buffer = "";
      if (this.child) {
        this._invalidate(this.child, httpError(502, "app-server output overflow"));
      }
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
    const { id, method, params } = message;
    let response;
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      // V2 approvals (Codex 0.167.0 schema): decision accept/decline/cancel.
      // Only the fully automatic container configuration approves; there is
      // no human approval surface, so humanCommand is always declined. No
      // session-scoped or policy-amending decisions are ever returned.
      const automatic = APPROVAL_POLICY === "never" && SANDBOX === "danger-full-access";
      const humanCommand = params && params.kind === "humanCommand";
      const decision = automatic && !humanCommand ? "accept" : "decline";
      response = { jsonrpc: "2.0", id, result: { decision } };
    } else if (method === "item/tool/requestUserInput") {
      response = { jsonrpc: "2.0", id, result: { answers: {} } };
    } else if (method === "item/permissions/requestApproval") {
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

  async request(
    method,
    params,
    timeoutMs = 30_000,
    allowBeforeInit = false,
    expectedGeneration = null,
  ) {
    const checkGeneration = () => {
      if (expectedGeneration !== null && this.generation !== expectedGeneration) {
        throw httpError(502, "app-server restarted; retry request");
      }
    };
    checkGeneration();
    if (!allowBeforeInit) {
      await this.start();
      checkGeneration();
    }
    const generation = this.generation;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry && entry.generation === generation) {
          this.pending.delete(id);
          reject(new Error(`app-server ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, generation });
      try {
        this._send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        if (this.pending.get(id)?.generation === generation) {
          this.pending.delete(id);
        }
        reject(error);
      }
    });
  }

  async stop() {
    this.shuttingDown = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    if (!child) return;
    // Reject outstanding work; no restart may happen during shutdown.
    this._invalidate(child, httpError(502, "app-server shutting down"));
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Conversation & Turn management
// ---------------------------------------------------------------------------

const conversations = new Map(); // conversationId -> entry {threadId, generation, users, queue, ...}
const pendingThreads = new Map(); // conversationId -> Promise<entry>
const activeTurns = new Map(); // threadId -> {turnId, generation, cancel}

function invalidateConversationState(generation) {
  for (const [key, entry] of conversations) {
    if (entry.generation === generation) conversations.delete(key);
  }
  for (const [threadId, active] of activeTurns) {
    if (active.generation === generation) activeTurns.delete(threadId);
  }
}

const appServer = new AppServer({
  onInvalidate: invalidateConversationState,
});

function validateCwd(requested, workspace = WORKSPACE) {
  if (!requested) return workspace;
  if (typeof requested !== "string" || requested.includes("\0")) {
    throw httpError(400, "cwd must be a valid path string");
  }
  const resolved = path.resolve(requested);
  const root = workspace.endsWith(path.sep) ? workspace : workspace + path.sep;
  if (resolved !== workspace && !resolved.startsWith(root)) {
    throw httpError(400, `cwd must be inside ${workspace}`);
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
  const candidates = [
    body.conversation_id,
    body.metadata && body.metadata.conversation_id,
    req.headers["x-conversation-id"],
    body.user,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw httpError(400, "conversation id must be a non-empty string");
    }
    return candidate;
  }
  // No explicit identifier: every request gets its own conversation instead
  // of silently sharing one hidden "default" thread.
  return randomUUID();
}

// Explicit configuration must match an existing conversation; omitted
// fields inherit the entry configuration. Conflicts are never ignored.
function checkConversationConfig(entry, body, system) {
  const conflict = () =>
    httpError(409, "conversation configuration conflict; use a new conversation_id");
  if (body.cwd !== undefined && body.cwd !== null && body.cwd !== "") {
    if (validateCwd(body.cwd) !== entry.cwd) throw conflict();
  }
  if (system && system !== entry.developerInstructions) throw conflict();
  if (body.model) {
    if (body.model !== entry.requestedModel && body.model !== entry.model) {
      throw conflict();
    }
  }
}

function evictOldestConversations() {
  if (conversations.size < MAX_CONVERSATIONS) return;
  for (const [key, entry] of conversations) {
    if (conversations.size < MAX_CONVERSATIONS) break;
    // Never evict an entry with waiting or running requests.
    if (entry.users > 0 || activeTurns.has(entry.threadId)) continue;
    conversations.delete(key);
  }
}

// Abort-aware wait: a disconnecting client stops waiting immediately, but
// shared work (thread creation) is never cancelled on its behalf.
function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(httpError(499, "client disconnected"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(httpError(499, "client disconnected"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function createThread(conversationId, body, generation) {
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

  const response = await appServer.request(
    "thread/start",
    params,
    60_000,
    false,
    generation,
  );
  const threadId = response?.thread?.id;
  if (!threadId) throw new Error("thread/start returned no thread id");

  const entry = {
    threadId,
    generation,
    developerInstructions: system,
    // Actual configuration reported by thread/start, plus the requested
    // model for alias comparisons.
    model: response.model || model || null,
    requestedModel: model || null,
    cwd: response.cwd || cwd,
    users: 0,
    queue: Promise.resolve(),
  };
  if (THREAD_MODE !== "ephemeral") {
    // Publish only while this generation is still the current one.
    if (appServer.generation !== generation) {
      throw httpError(502, "app-server restarted; retry request");
    }
    evictOldestConversations();
    conversations.set(conversationId, entry);
  }
  log(`created thread ${threadId} for conversation ${conversationId}`);
  return entry;
}

async function getThread(conversationId, body, signal) {
  // Validate messages and explicit configuration before any thread access.
  const { system } = normalizeMessages(body);
  validateCwd(body.cwd);
  await awaitWithSignal(appServer.start(), signal);
  const generation = appServer.generation;
  if (THREAD_MODE === "ephemeral") {
    return createThread(conversationId, body, generation);
  }
  const existing = conversations.get(conversationId);
  if (existing && existing.generation === generation) {
    checkConversationConfig(existing, body, system);
    // Refresh insertion order for LRU eviction.
    conversations.delete(conversationId);
    conversations.set(conversationId, existing);
    return existing;
  }
  const inflight = pendingThreads.get(conversationId);
  if (inflight) {
    const entry = await awaitWithSignal(inflight, signal);
    // Waiters behind a shared creation are checked against the same entry.
    checkConversationConfig(entry, body, system);
    return entry;
  }

  const promise = createThread(conversationId, body, generation).finally(() => {
    // Only this promise may remove its own reservation.
    if (pendingThreads.get(conversationId) === promise) {
      pendingThreads.delete(conversationId);
    }
  });
  pendingThreads.set(conversationId, promise);
  return awaitWithSignal(promise, signal);
}

// Interrupt recovery: after sending turn/interrupt the turn must reach a
// terminal completion within this window, otherwise the child is invalid.
const INTERRUPT_RECOVERY_MS = 10_000;

function runTurn(entry, body, onDelta, signal, { accumulateText = true } = {}) {
  const { lastUser } = normalizeMessages(body);
  const run = async () => {
    // Stale queue entries from a previous child generation never start work.
    if (entry.generation !== appServer.generation) {
      return { turnId: null, error: httpError(502, "app-server restarted; retry request"), text: "" };
    }
    if (signal?.aborted) {
      return { turnId: null, error: httpError(499, "client disconnected"), text: "" };
    }
    const generation = entry.generation;
    let turnId = null;
    let delivered = "";
    let hasDelivered = false;
    let finished = false;
    let finalError = null;
    let cancelReason = null; // {error} once a cancel was requested
    let interruptSent = false;
    let deadlineTimer = null;
    let recoveryTimer = null;
    let resolveFinish;
    const finishedPromise = new Promise((resolve) => {
      resolveFinish = resolve;
    });

    // Events arriving before the turn/start response are buffered and only
    // applied once the confirmed turn id is known.
    const preStartEvents = [];
    let preStartBytes = 0;

    const unsubscribers = [];
    const cleanup = () => {
      clearTimeout(deadlineTimer);
      clearTimeout(recoveryTimer);
      for (const off of unsubscribers) off();
      unsubscribers.length = 0;
      if (signal) signal.removeEventListener("abort", onAbort);
      const active = activeTurns.get(entry.threadId);
      if (active && active.cancel === cancel) activeTurns.delete(entry.threadId);
    };

    const done = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolveFinish({ error: error || null });
    };

    const sendInterrupt = () => {
      if (interruptSent || !turnId) return;
      interruptSent = true;
      appServer
        .request(
          "turn/interrupt",
          { threadId: entry.threadId, turnId },
          10_000,
          false,
          generation,
        )
        .catch((error) => {
          log(`turn/interrupt failed: ${error.message}`);
        });
      // Bounded recovery: without a terminal completion the child is invalid.
      recoveryTimer = setTimeout(() => {
        if (!finished) {
          appServer.invalidate(httpError(502, "interrupted turn did not complete; restarting app-server"));
        }
      }, INTERRUPT_RECOVERY_MS);
    };

    // Single cancel path for client disconnect, /v1/interrupt and timeout.
    // Resolves only when the turn reached a safe end.
    const cancel = (error) => {
      if (finished) return finishedPromise;
      if (!cancelReason) cancelReason = { error };
      if (turnId) sendInterrupt();
      // Before the start response: remember the cancel; it is applied as
      // soon as the turn id is confirmed.
      return finishedPromise;
    };

    function onAbort() {
      cancel(httpError(499, "client disconnected"));
    }

    const applyEvent = (method, params) => {
      if (method === "item/agentMessage/delta") {
        if (params.threadId !== entry.threadId || params.turnId !== turnId) return;
        if (typeof params.delta === "string") {
          hasDelivered = true;
          if (accumulateText) delivered += params.delta;
          onDelta(params.delta);
        }
        return;
      }
      if (method === "turn/completed") {
        if (params.threadId !== entry.threadId) return;
        const completed = params.turn || {};
        if (completed.id !== turnId) return;
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
        // Terminal status decides the outcome (TurnStatus in the pinned
        // schema): only "completed" without error succeeds.
        if (completed.status === "completed" && !completed.error) {
          done(cancelReason ? cancelReason.error : finalError);
        } else if (completed.status === "interrupted") {
          done(cancelReason ? cancelReason.error : httpError(409, "turn interrupted"));
        } else if (completed.status === "failed") {
          done(httpError(502, errorMessage(completed.error, "turn failed")));
        } else {
          done(
            httpError(
              502,
              `app-server protocol error: unexpected terminal turn status ${JSON.stringify(completed.status)}`,
            ),
          );
        }
        return;
      }
      if (method === "error") {
        if (params?.threadId !== entry.threadId || params?.turnId !== turnId) return;
        const message = errorMessage(params?.error, "turn failed");
        if (params?.willRetry) {
          // Codex is retrying internally; keep listening for the real
          // terminal completion instead of failing the HTTP request.
          log(`app-server error (will retry): ${message}`);
          return;
        }
        finalError = httpError(502, message);
      }
    };

    const handleTurnEvent = (method, params) => {
      if (finished) return;
      if (params?.threadId && params.threadId !== entry.threadId) return;
      if (!turnId) {
        const size = JSON.stringify(params).length;
        if (preStartBytes + size > MAX_RPC_BUFFER_BYTES) {
          appServer.invalidate(httpError(502, "app-server event buffer overflow before turn start"));
          return;
        }
        preStartBytes += size;
        preStartEvents.push({ method, params });
        return;
      }
      applyEvent(method, params);
    };

    // Subscribe before turn/start: a fast turn can complete before the RPC
    // response is processed.
    unsubscribers.push(
      appServer.on("item/agentMessage/delta", (params) => handleTurnEvent("item/agentMessage/delta", params)),
      appServer.on("turn/completed", (params) => handleTurnEvent("turn/completed", params)),
      appServer.on("error", (params) => handleTurnEvent("error", params)),
      appServer.on("server/exited", (params) => {
        done(httpError(502, params?.message || "app-server exited during turn"));
      }),
    );

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    // The turn deadline starts at queue start and covers turn/start.
    deadlineTimer = setTimeout(() => {
      cancel(httpError(504, "turn timed out"));
    }, TURN_TIMEOUT_MS);

    let response;
    try {
      response = await appServer.request(
        "turn/start",
        {
          threadId: entry.threadId,
          input: [{ type: "text", text: lastUser }],
        },
        Math.min(60_000, TURN_TIMEOUT_MS),
        false,
        generation,
      );
    } catch (error) {
      done(error);
      const result = await finishedPromise;
      return { turnId, error: result.error, text: delivered };
    }

    const startedTurnId = response?.turn?.id;
    if (!startedTurnId) {
      // Unresolvable start: never leave agent work running unowned.
      appServer.invalidate(httpError(502, "turn/start returned no turn id"));
      done(httpError(502, "turn/start returned no turn id"));
      const result = await finishedPromise;
      return { turnId, error: result.error, text: delivered };
    }
    if (!finished) {
      turnId = startedTurnId;
      activeTurns.set(entry.threadId, { turnId, generation, cancel });
      const buffered = preStartEvents.splice(0);
      preStartBytes = 0;
      for (const event of buffered) applyEvent(event.method, event.params);
      if (cancelReason && !finished) sendInterrupt();
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
  // A waiter that disconnects while queued gets an immediate error; run()
  // still checks the signal at queue start so no turn is ever started.
  return signal ? awaitWithSignal(queued, signal) : queued;
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
    const apiKey = data.OPENAI_API_KEY || process.env.OPENAI_API_KEY || null;
    const accessToken = tokens.access_token || null;
    return {
      // Auth configuration means usable credentials, not just auth_mode.
      // This does not validate tokens online.
      loggedIn: Boolean(apiKey || accessToken),
      authMode: data.auth_mode || (apiKey ? "apiKey" : null),
      accountId: tokens.account_id || null,
      accessToken,
      apiKey,
    };
  } catch {
    const apiKey = process.env.OPENAI_API_KEY || null;
    return {
      loggedIn: Boolean(apiKey),
      authMode: apiKey ? "apiKey" : null,
      accountId: null,
      accessToken: null,
      apiKey,
    };
  }
}

// Remote-control state comes exclusively from the worker's atomic status
// file. "connected" requires a fresh checkedAt (<= 90 s, not in the future);
// a running daemon alone never implies connectivity.
const REMOTE_STATUS_MAX_AGE_MS = 90_000;

async function readRemoteStatus() {
  let data;
  try {
    const raw = await readFile(
      path.join(CODEX_HOME, "dot-remote-status.json"),
      "utf8",
    );
    data = JSON.parse(raw);
    if (!data || typeof data !== "object") throw new Error("invalid status file");
  } catch {
    return {
      connected: false,
      status: "unknown",
      serverName: null,
      environmentId: null,
      checkedAt: null,
    };
  }
  const checkedAt = typeof data.checkedAt === "string" ? data.checkedAt : null;
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : NaN;
  const now = Date.now();
  const fresh =
    Number.isFinite(checkedAtMs) &&
    checkedAtMs <= now &&
    now - checkedAtMs <= REMOTE_STATUS_MAX_AGE_MS;
  const status = data.status || "unknown";
  return {
    connected: status === "connected" && fresh,
    status: status === "connected" && !fresh ? "stale" : status,
    serverName: data.serverName || null,
    environmentId: data.environmentId || null,
    checkedAt,
  };
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

// Determined once per successful app-server start; probes never spawn CLI
// subprocesses.
let versionAtStart = null;
async function cacheVersionAtStart() {
  try {
    const { stdout } = await runCodex(["--version"], 5000);
    versionAtStart = stdout.trim() || null;
  } catch {
    versionAtStart = null;
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// Abort the request when the client goes away before the response finished
// normally. The same signal drives thread acquisition and the turn queue.
function requestAbort(req, res) {
  const controller = new AbortController();
  const onGone = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", onGone);
  res.on("close", onGone);
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", onGone);
      res.off("close", onGone);
    },
  };
}

async function handleChatCompletions(req, res, body) {
  const conversationId = conversationIdFor(body, req);
  const abort = requestAbort(req, res);
  let entry;
  try {
    entry = await getThread(conversationId, body, abort.signal);
  } catch (error) {
    abort.dispose();
    throw error;
  }
  if (abort.signal.aborted) {
    abort.dispose();
    throw httpError(499, "client disconnected");
  }
  entry.users += 1;
  const releaseEntry = () => {
    entry.users -= 1;
  };
  const model = entry.model || MODEL || "codex";
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (body.stream === true) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Conversation-Id": conversationId,
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
    // The abort controller created before getThread also covers the stream.

    try {
      const result = await runTurn(
        entry,
        body,
        (delta) => write(chunk({ content: delta })),
        abort.signal,
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
      abort.dispose();
      releaseEntry();
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  try {
    const result = await runTurn(entry, body, () => {}, abort.signal);
    if (result.error) {
      throw httpError(result.error.statusCode || 502, errorMessage(result.error));
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
      conversation_id: conversationId,
      thread_id: entry.threadId,
    });
  } finally {
    abort.dispose();
    releaseEntry();
  }
}

async function handleSimpleChat(req, res, body) {
  const conversationId = conversationIdFor(body, req);
  const abort = requestAbort(req, res);
  let entry;
  try {
    entry = await getThread(conversationId, body, abort.signal);
  } catch (error) {
    abort.dispose();
    throw error;
  }
  entry.users += 1;
  try {
    if (abort.signal.aborted) throw httpError(499, "client disconnected");
    const result = await runTurn(entry, body, () => {}, abort.signal);
    if (result.error) {
      throw httpError(result.error.statusCode || 502, errorMessage(result.error));
    }
    sendJson(res, 200, {
      reply: result.text,
      thread_id: entry.threadId,
      conversation_id: conversationId,
    });
  } finally {
    entry.users -= 1;
    abort.dispose();
  }
}

function appServerReady() {
  return Boolean(appServer.child && appServer.initialized && !appServer.shuttingDown);
}

// Liveness: the HTTP process serves requests. No file, CLI or network work.
async function handleLivez(req, res) {
  sendJson(res, 200, { ok: true });
}

// Readiness: initialized app-server plus auth configuration. Remote control
// and Dots are separate features and never block an otherwise usable chat.
async function handleReadyz(req, res) {
  const auth = await readAuth();
  const ready = appServerReady() && auth.loggedIn;
  sendJson(res, ready ? 200 : 503, { ready });
}

async function handleHealth(req, res) {
  const [auth, remote, installationId] = await Promise.all([
    readAuth(),
    readRemoteStatus(),
    readInstallationId(),
  ]);
  const ready = appServerReady() && auth.loggedIn;
  sendJson(res, 200, {
    ok: true,
    ready,
    appServer: { ready: appServerReady() },
    codex: { version: versionAtStart || (await codexVersion()), bin: CODEX_BIN },
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
  const active = activeTurns.get(threadId);
  if (!active) {
    throw httpError(404, "no active turn for that thread");
  }
  // Same cancel path as client aborts; respond only after the turn reached
  // a safe terminal end.
  const result = await active.cancel(httpError(409, "turn interrupted"));
  if (result.error && result.error.statusCode !== 409) {
    throw httpError(result.error.statusCode || 502, errorMessage(result.error));
  }
  sendJson(res, 200, { ok: true, thread_id: threadId, turn_id: active.turnId });
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
      res.setHeader("Access-Control-Expose-Headers", "X-Conversation-Id");
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
    if (req.method === "GET" && url.pathname === "/livez") {
      await handleLivez(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/readyz") {
      await handleReadyz(req, res);
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
    const address = server.address();
    const boundPort = address && typeof address === "object" ? address.port : PORT;
    log(`listening on ${BIND}:${boundPort} workspace=${WORKSPACE} codex=${CODEX_BIN}`);
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
