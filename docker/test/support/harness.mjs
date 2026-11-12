// Reusable test harness: starts the real server.js against the fake codex
// with a private HOME/CODEX_HOME/workspace, an ephemeral API port, and a
// per-test Unix control socket for deterministic synchronization.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_JS = path.join(here, "..", "..", "server.js");
export const FAKE_CODEX = path.join(here, "fake-codex.mjs");

const START_DEADLINE_MS = 5000;
const CONTROL_DEADLINE_MS = 5000;
const LOG_LIMIT_BYTES = 64 * 1024;

// Minimal child environment: never inherit host tokens, NODE_OPTIONS,
// proxies or foreign DOT_* variables.
export function childEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: overrides.HOME || tmpdir(),
    TMPDIR: tmpdir(),
    LANG: "C.UTF-8",
    ...overrides,
  };
}

function deadline(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms).unref();
  });
}

function tailBuffer(limit = LOG_LIMIT_BYTES) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      if (buffer.length > limit) buffer = buffer.slice(-limit);
    },
    get text() {
      return buffer;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake control socket
// ---------------------------------------------------------------------------

function createControlServer(socketPath) {
  const events = [];
  const waiters = [];
  let socket = null;
  const pendingCommands = [];
  let connectedResolve;
  const connected = new Promise((resolve) => {
    connectedResolve = resolve;
  });

  const server = createServer((conn) => {
    socket = conn;
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "hello") {
          // The fake's command handler is installed: flush pre-armed holds
          // and acknowledge before it processes any stdin request.
          for (const command of pendingCommands.splice(0)) {
            conn.write(`${JSON.stringify(command)}\n`);
          }
          conn.write(`${JSON.stringify({ cmd: "holds-ready" })}\n`);
          connectedResolve();
          continue;
        }
        events.push(event);
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          if (waiters[i].predicate(event)) {
            const waiter = waiters.splice(i, 1)[0];
            waiter.resolve(event);
          }
        }
      }
    });
    conn.on("error", () => {});
  });

  const send = (command) => {
    if (!socket || !socket.writable) {
      // Commands issued before the fake connects (pre-armed holds) are
      // flushed when the connection arrives.
      pendingCommands.push(command);
      return;
    }
    socket.write(`${JSON.stringify(command)}\n`);
  };

  return {
    server,
    events,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    },
    async waitConnected(timeoutMs = START_DEADLINE_MS) {
      await Promise.race([connected, deadline(timeoutMs, "fake control connection")]);
    },
    hold(point, match = null) {
      send({ cmd: "hold", point, match });
    },
    release(point, match = null) {
      send({ cmd: "release", point, match });
    },
    // Resolve with the first matching event (already seen or future).
    async waitFor(predicate, { timeoutMs = CONTROL_DEADLINE_MS, label = "control event" } = {}) {
      const found = events.find(predicate);
      if (found) return found;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      });
      return promise;
    },
    waitForRequest(method, match = null, options = {}) {
      return this.waitFor(
        (event) =>
          event.type === "request" &&
          event.method === method &&
          (!match ||
            Object.entries(match).every(([key, value]) =>
              event.params ? event.params[key] === value : false,
            )),
        { label: `request ${method}`, ...options },
      );
    },
    async close() {
      if (socket) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge process
// ---------------------------------------------------------------------------

/**
 * Start server.js against the fake codex.
 *
 * Returns { baseUrl, child, logs, control, tmp, home, codexHome, workspace,
 * post, get, restartCodex }. Cleanup is registered via t.after: TERM, wait
 * for close, KILL after 3 s, then remove temporary directories.
 */
export async function startBridge(t, { env = {}, scenario = "normal", holds = [] } = {}) {
  const tmp = await mkdtemp(path.join(tmpdir(), "dot-test-"));
  const home = path.join(tmp, "home");
  const codexHome = path.join(tmp, "codex");
  const workspace = path.join(tmp, "workspace");
  const socketPath = path.join(tmp, "control.sock");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(home, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const control = createControlServer(socketPath);
  await control.listen();
  // Queue holds before the fake connects; they are flushed on connection.
  for (const hold of holds) control.hold(hold.point, hold.match || null);

  const logs = { stdout: tailBuffer(), stderr: tailBuffer() };
  const envOverrides = {
    HOME: home,
    CODEX_HOME: codexHome,
    CODEX_BIN: FAKE_CODEX,
    DOT_WORKSPACE: workspace,
    DOT_API_PORT: "0",
    DOT_BIND: "127.0.0.1",
    DOT_API_KEY: "",
    DOT_CORS_ORIGINS: "",
    DOT_TEST_CONTROL_SOCKET: socketPath,
    DOT_FAKE_SCENARIO: scenario,
    ...env,
  };
  const child = spawn(process.execPath, [SERVER_JS], {
    env: childEnv(envOverrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => logs.stdout.push(chunk));
  child.stderr.on("data", (chunk) => logs.stderr.push(chunk));

  let exited = false;
  const exitPromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      exited = true;
      resolve({ code, signal });
    });
  });

  t.after(async () => {
    if (!exited) {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exitPromise;
      clearTimeout(killTimer);
    }
    await control.close();
    await rm(tmp, { recursive: true, force: true });
  });

  // The product logs the actually bound port from server.address().
  const baseUrl = await Promise.race([
    (async () => {
      for (;;) {
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(logs.stdout.text);
        if (match) return `http://127.0.0.1:${match[1]}`;
        if (exited) {
          throw new Error(`bridge exited before listening:\n${logs.stderr.text}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })(),
    deadline(START_DEADLINE_MS, "bridge start"),
  ]);

  // The fake connects to the control socket during app-server startup;
  // commands are only valid once that connection exists. A custom CODEX_BIN
  // (e.g. a broken path) never runs the fake, so there is nothing to wait for.
  if (!env.CODEX_BIN || env.CODEX_BIN === FAKE_CODEX) {
    await control.waitConnected();
  }

  const post = (p, body, headers = {}) =>
    fetch(`${baseUrl}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (p, headers = {}) => fetch(`${baseUrl}${p}`, { headers });

  // Wait until the bridge reports at least `count` initialized app-server
  // generations (recovery after a crash).
  const waitReady = async (count = 1, timeoutMs = 5000) => {
    const started = Date.now();
    for (;;) {
      const found = (logs.stdout.text.match(/app-server initialized/g) || []).length;
      if (found >= count) return;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`app-server not initialized ${count}x within ${timeoutMs}ms:\n${logs.stdout.text}\n${logs.stderr.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  return {
    baseUrl,
    child,
    logs,
    control,
    tmp,
    home,
    codexHome,
    workspace,
    post,
    get,
    exitPromise,
    waitReady,
    get exited() {
      return exited;
    },
  };
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/** Parse an SSE body into frames: {data} objects, raw [DONE], comments. */
export function parseSse(text) {
  const frames = [];
  for (const block of text.split(/\n\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(":")) {
      frames.push({ comment: trimmed.slice(1).trim() });
      continue;
    }
    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      frames.push({ done: true });
    } else {
      frames.push({ data: JSON.parse(data) });
    }
  }
  return frames;
}

/**
 * Assert a complete successful SSE stream: role chunk, content deltas with
 * the full text in order, exactly one terminal stop frame, then [DONE].
 */
export function assertSseSuccess(text, expectedContent) {
  const frames = parseSse(text).filter((frame) => !frame.comment);
  const dataFrames = frames.filter((frame) => frame.data);
  assert.ok(frames.length >= 3, `expected SSE frames, got: ${text}`);
  assert.deepEqual(frames[frames.length - 1], { done: true }, "stream must end with [DONE]");
  assert.equal(frames[frames.length - 2].data.choices?.[0]?.finish_reason, "stop");
  const terminal = dataFrames.filter(
    (frame) => frame.data.choices?.[0]?.finish_reason != null,
  );
  assert.equal(terminal.length, 1, "exactly one terminal frame");
  assert.equal(terminal[0].data.choices[0].finish_reason, "stop");
  const content = dataFrames
    .map((frame) => frame.data.choices?.[0]?.delta?.content || "")
    .join("");
  assert.equal(content, expectedContent);
  assert.equal(dataFrames[0].data.choices[0].delta.role, "assistant");
  for (const frame of dataFrames) {
    assert.equal(frame.data.object, "chat.completion.chunk");
  }
  return dataFrames;
}

/** Wait until predicate holds, polling every 25 ms within a deadline. */
export async function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${label} not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}