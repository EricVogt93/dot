#!/usr/bin/env node
/**
 * Dot container API.
 *
 * Bridges HTTP/OpenAI-style chat requests to one long-lived Codex app-server
 * child process (newline-delimited JSON-RPC over stdio) and exposes the
 * remote-control pairing/device information used by the ChatGPT GUI.
 *
 * Zero npm dependencies.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

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
const TURN_TIMEOUT_MS = Number(process.env.DOT_TURN_TIMEOUT_MS || 600000);
const MAX_BODY_BYTES = 1024 * 1024;

function log(message, extra) {
  const line = `[dot-api] ${new Date().toISOString()} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
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

function authorized(req, url) {
  if (!API_KEY) return true;
  if (url.pathname === "/health") return true;
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && safeEqual(match[1], API_KEY));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body is not valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function runCodex(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_BIN, args, {
      env: { ...process.env, CODEX_HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `codex ${args.join(" ")} exited ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseLastJson(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  constructor() {
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.starting = null;
    this.initialized = false;
    this.shuttingDown = false;
    this.restartDelay = 1000;
    this.restartTimer = null;
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this._spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async _spawnAndInitialize() {
    const child = spawn(
      CODEX_BIN,
      ["app-server", "--listen", "stdio://", "--analytics-default-enabled"],
      {
        env: { ...process.env, CODEX_HOME },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    this.initialized = false;
    this.buffer = "";

    child.stdout.on("data", (data) => this._onData(data));
    child.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text) log(`app-server stderr: ${text.slice(-2000)}`);
    });
    child.on("error", (error) => log(`app-server spawn error: ${error.message}`));
    child.on("exit", (code, signal) => {
      log(`app-server exited code=${code} signal=${signal}`);
      this.child = null;
      this.initialized = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("app-server exited"));
      }
      this.pending.clear();
      this._scheduleRestart();
    });

    const response = await this.request(
      "initialize",
      {
        clientInfo: {
          name: "dot-container",
          title: "Dot Container",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      },
      30000,
      true,
    );
    this._send({ jsonrpc: "2.0", method: "initialized", params: {} });
    this.initialized = true;
    this.restartDelay = 1000;
    // Thread ids belong to the previous process; force recreation after a
    // crash or restart.
    conversations.clear();
    activeTurns.clear();
    log(`app-server initialized: ${response.userAgent}`);
  }

  _scheduleRestart() {
    if (this.shuttingDown || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, 30000);
    log(`restarting app-server in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().catch((error) => log(`app-server restart failed: ${error.message}`));
    }, delay);
  }

  _send(message) {
    const child = this.child;
    if (!child || !child.stdin.writable) {
      throw new Error("app-server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _onData(data) {
    this.buffer += data.toString();
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this._onLine(line);
      index = this.buffer.indexOf("\n");
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
      const handlers = this.listeners.get(message.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message.params || {});
          } catch (error) {
            log(`notification handler failed: ${error.message}`);
          }
        }
      }
    }
  }

  _replyToServerRequest(message) {
    const method = message.method;
    let result = null;
    if (
      method === "execCommandApproval" ||
      method === "applyPatchApproval"
    ) {
      result = { decision: "approved" };
    } else if (method === "fileChangeRequestApproval") {
      result = { decision: "accept" };
    } else if (method === "permissionsRequestApproval") {
      // The container grants the sandbox it was started with; deny ad-hoc
      // permission escalations instead of silently widening it.
      result = { error: { code: -32601, message: "permission escalation unsupported" } };
    } else if (method === "toolRequestUserInput") {
      result = { answers: {} };
    } else {
      result = {
        error: { code: -32601, message: `unsupported server request: ${method}` },
      };
    }
    try {
      this._send({ jsonrpc: "2.0", id: message.id, result });
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
    return () => set.delete(handler);
  }

  async request(method, params, timeoutMs = 30000, allowBeforeInit = false) {
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
    if (child) {
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
}

const appServer = new AppServer();
const conversations = new Map(); // conversationId -> {threadId, developerInstructions, model, queue}
const activeTurns = new Map(); // threadId -> turnId

function validateCwd(requested) {
  if (!requested) return WORKSPACE;
  const resolved = path.resolve(String(requested));
  const root = WORKSPACE.endsWith(path.sep) ? WORKSPACE : WORKSPACE + path.sep;
  if (resolved !== WORKSPACE && !resolved.startsWith(root)) {
    const error = new Error(`cwd must be inside ${WORKSPACE}`);
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (part && part.type === "text" && typeof part.text === "string") {
        parts.push(part.text);
      } else {
        const error = new Error(
          "Only text content parts are supported by this bridge",
        );
        error.statusCode = 400;
        throw error;
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
    const error = new Error("at least one user message is required");
    error.statusCode = 400;
    throw error;
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

async function getThread(conversationId, body) {
  let entry = conversations.get(conversationId);
  if (entry && entry.threadId) return entry;

  const { system, lastUser } = normalizeMessages(body);
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

  const response = await appServer.request("thread/start", params, 60000);
  const threadId = response && response.thread && response.thread.id;
  if (!threadId) throw new Error("thread/start returned no thread id");
  entry = {
    threadId,
    developerInstructions: system,
    model: model || null,
    queue: Promise.resolve(),
  };
  conversations.set(conversationId, entry);
  log(`created thread ${threadId} for conversation ${conversationId}`);
  return entry;
}

function runTurn(entry, body, onDelta, signal) {
  const run = async () => {
    const { lastUser } = normalizeMessages(body);
    let turnId = null;
    let delivered = "";
    let finished = false;
    let aborted = false;
    let timer = null;
    let resolveFinish;
    const finishedPromise = new Promise((resolve) => {
      resolveFinish = resolve;
    });

    let offDelta = () => {};
    let offCompleted = () => {};
    let offError = () => {};

    function cleanup() {
      clearTimeout(timer);
      offDelta();
      offCompleted();
      offError();
      if (signal) signal.removeEventListener("abort", onAbort);
      if (turnId && activeTurns.get(entry.threadId) === turnId) {
        activeTurns.delete(entry.threadId);
      }
    }

    function done(error) {
      if (finished) return;
      finished = true;
      cleanup();
      resolveFinish({ error: error || null });
    }

    function onAbort() {
      aborted = true;
      if (!turnId) return; // interrupt after turn/start returns
      appServer
        .request("turn/interrupt", { threadId: entry.threadId, turnId }, 10000)
        .catch(() => {});
      done(new Error("client disconnected"));
    }

    // Listen before turn/start: a fast turn can complete before the RPC
    // response is read.
    offDelta = appServer.on("item/agentMessage/delta", (params) => {
      if (params.threadId !== entry.threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId) return;
      if (typeof params.delta === "string") {
        delivered += params.delta;
        onDelta(params.delta);
      }
    });
    offCompleted = appServer.on("turn/completed", (params) => {
      if (params.threadId !== entry.threadId) return;
      const completed = params.turn || {};
      if (turnId && completed.id && completed.id !== turnId) return;
      if (!turnId && completed.id) turnId = completed.id;
      if (!completed.error && !delivered) {
        const items = Array.isArray(completed.items) ? completed.items : [];
        for (const item of items) {
          if (item && item.type === "agentMessage" && item.text) {
            delivered += item.text;
            onDelta(item.text);
          }
        }
      }
      done(completed.error || null);
    });
    offError = appServer.on("error", (params) => {
      done(
        new Error(
          (params && (params.message || params.error)) || "turn failed",
        ),
      );
    });

    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let response;
    try {
      response = await appServer.request(
        "turn/start",
        {
          threadId: entry.threadId,
          input: [{ type: "text", text: lastUser }],
        },
        60000,
      );
    } catch (error) {
      done(error);
      throw error;
    }

    const startedTurnId = response && response.turn && response.turn.id;
    if (!turnId) turnId = startedTurnId || null;
    if (!finished) {
      if (turnId) activeTurns.set(entry.threadId, turnId);
      timer = setTimeout(() => {
        appServer
          .request(
            "turn/interrupt",
            { threadId: entry.threadId, turnId },
            10000,
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

  // Serialize turns for the same thread; the app-server does not allow
  // concurrent turns on one thread.
  const queued = entry.queue.then(run, run);
  entry.queue = queued.catch(() => {});
  return queued;
}

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
    }, 15000);
    const controller = new AbortController();
    req.on("close", () => controller.abort());

    try {
      const result = await runTurn(
        entry,
        body,
        (delta) => write(chunk({ content: delta })),
        controller.signal,
      );
      if (result.error) {
        write({ error: { message: String(result.error.message || result.error) } });
      } else {
        write(chunk({}, "stop"));
      }
    } catch (error) {
      write({ error: { message: error.message } });
    } finally {
      clearInterval(ping);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
    return;
  }

  const result = await runTurn(entry, body, () => {});
  if (result.error) {
    const error = new Error(String(result.error.message || result.error));
    error.statusCode = 502;
    throw error;
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
      connected: data.status === "running" && data.appServerVersion === data.cliVersion,
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
    cachedVersion = stdout.trim() || "unknown";
  } catch {
    cachedVersion = "unavailable";
  }
  return cachedVersion;
}

async function handleHealth(req, res) {
  const [auth, remote, version] = await Promise.all([
    readAuth(),
    readRemoteStatus(),
    codexVersion(),
  ]);
  let installationId = null;
  try {
    installationId = (
      await readFile(path.join(CODEX_HOME, "installation_id"), "utf8")
    ).trim();
  } catch {
    // Optional.
  }
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
  const auth = await readAuth();
  if (!auth.accessToken) {
    sendJson(res, 401, {
      error: "No ChatGPT access token in auth.json; run device login first.",
    });
    return;
  }
  let installationId = null;
  try {
    installationId = (
      await readFile(path.join(CODEX_HOME, "installation_id"), "utf8")
    ).trim();
  } catch {
    // Optional.
  }
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "User-Agent": "codex-cli/dot-container",
  };
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
  try {
    const response = await fetch(
      "https://chatgpt.com/backend-api/wham/remote/control/environments",
      { headers, signal: AbortSignal.timeout(15000) },
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
    sendJson(res, 502, { error: error.message });
  }
}

async function handlePair(req, res) {
  try {
    const { stdout } = await runCodex(["remote-control", "pair", "--json"], 15000);
    sendJson(res, 200, parseLastJson(stdout));
  } catch (error) {
    sendJson(res, 502, { error: error.message });
  }
}

async function handleInterrupt(req, res, body) {
  const threadId = body.thread_id || body.threadId;
  if (!threadId) {
    sendJson(res, 400, { error: "thread_id is required" });
    return;
  }
  const turnId = activeTurns.get(threadId);
  if (!turnId) {
    sendJson(res, 404, { error: "no active turn for that thread" });
    return;
  }
  await appServer.request("turn/interrupt", { threadId, turnId }, 10000);
  sendJson(res, 200, { ok: true, thread_id: threadId, turn_id: turnId });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
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
      const entry = await getThread(conversationIdFor(body, req), body);
      const result = await runTurn(entry, body, () => {});
      if (result.error) {
        sendJson(res, 502, { error: String(result.error.message || result.error) });
        return;
      }
      sendJson(res, 200, {
        reply: result.text,
        thread_id: entry.threadId,
        conversation_id: conversationIdFor(body, req),
      });
      return;
    }
    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/v1/remote/pair"
    ) {
      await handlePair(req, res);
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/v1/remote/environments"
    ) {
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
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(PORT, BIND, () => {
  log(`listening on ${BIND}:${PORT} workspace=${WORKSPACE} codex=${CODEX_BIN}`);
  appServer.start().catch((error) => log(`initial app-server start failed: ${error.message}`));
});

async function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close();
  await appServer.stop();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
