#!/usr/bin/env node
// Test double for the `codex` CLI. Implements the subset server.js calls:
// `--version`, `remote-control pair`, and a newline-delimited JSON-RPC
// `app-server --listen stdio://`.
//
// Protocol fixtures follow the pinned Codex 0.167.0 schemas
// (openai/codex commit 086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a,
// codex-rs/app-server-protocol/schema):
//   - ServerRequest: item/commandExecution/requestApproval,
//     item/fileChange/requestApproval (decision: accept/decline/cancel/...),
//     item/permissions/requestApproval, item/tool/requestUserInput
//   - ErrorNotification: {error:{message,...}, willRetry, threadId, turnId}
//   - TurnCompletedNotification: {threadId, turn:{id, status, error, items}}
//     with TurnStatus completed | interrupted | failed | inProgress
//   - ThreadStartResponse: {thread, model, cwd, ...}
//
// State rules: threads belong to this process generation only, unknown
// thread ids are rejected, one active turn per thread, an interrupt is
// acknowledged immediately and completes as "interrupted" only when the
// test releases it. IDs carry a per-process generation prefix.
//
// When DOT_TEST_CONTROL_SOCKET is set, the fake connects to a Unix socket
// owned by the test harness: every received request is reported there and
// explicitly armed hold points (initialize, thread/start, turn/start) wait
// for a release command. Interrupt completion always waits for an explicit
// release in controlled mode. Without the socket the normal path runs
// immediately.
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log(process.env.DOT_FAKE_VERSION || "codex-cli 0.0.0-fake");
  process.exit(0);
}

if (args[0] === "remote-control" && args[1] === "pair") {
  console.log(JSON.stringify({ event: "starting" }));
  console.log(
    JSON.stringify({ manualPairingCode: "TEST-CODE", environmentId: "env_test" }),
  );
  process.exit(0);
}

if (args[0] !== "app-server") {
  console.error(`fake-codex: unsupported args ${args.join(" ")}`);
  process.exit(2);
}

const generation = randomUUID().slice(0, 8);
const MODEL = process.env.DOT_FAKE_MODEL || "fake-model";
// When set, thread/start reports this model as the actual one regardless of
// the requested model (alias resolution in the real server).
const MODEL_ACTUAL = process.env.DOT_FAKE_MODEL_ACTUAL || null;
const controlled = Boolean(process.env.DOT_TEST_CONTROL_SOCKET);
const threads = new Map(); // threadId -> {cwd, model, activeTurn, turns}
const pendingServerReqs = new Map(); // server->client id -> resolve
let turnCounter = 0;
let serverReqId = 1000;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

// ---------------------------------------------------------------------------
// Optional test control socket
// ---------------------------------------------------------------------------

let control = null;
const armedHolds = new Map(); // point -> predicate (armed before arrival)
const pendingReleases = new Map(); // point -> predicate (released before arrival)
const waitingHolds = new Map(); // point -> {predicate, resolve}

function matches(match, params) {
  if (!match) return true;
  return Object.entries(match).every(([key, value]) => {
    const actual = params ? params[key] : undefined;
    if (value !== null && typeof value === "object") {
      return actual !== null && typeof actual === "object" && matches(value, actual);
    }
    return actual === value;
  });
}

let controlReady = Promise.resolve();
if (controlled) {
  control = connect(process.env.DOT_TEST_CONTROL_SOCKET);
  control.on("error", () => {});
  // Handshake: the harness flushes pre-armed holds only after this hello,
  // and stdin processing waits for the holds to be acknowledged.
  let holdsAcked;
  controlReady = new Promise((resolve) => {
    holdsAcked = resolve;
  });
  control.once("connect", () => {
    control.write(`${JSON.stringify({ type: "hello", generation })}\n`);
  });
  let buffer = "";
  control.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      if (command.cmd === "holds-ready") {
        holdsAcked();
      } else if (command.cmd === "hold") {
        armedHolds.set(command.point, command.match || null);
      } else if (command.cmd === "release") {
        const waiting = waitingHolds.get(command.point);
        if (waiting) {
          waitingHolds.delete(command.point);
          waiting.resolve();
        } else {
          pendingReleases.set(command.point, command.match || null);
        }
      }
    }
  });
}

function report(payload) {
  if (control && control.writable) {
    control.write(`${JSON.stringify({ generation, ...payload })}\n`);
  }
}

// Consume a pre-issued release, or wait at an armed hold point.
async function waitHold(point, params) {
  if (!controlled) return;
  if (pendingReleases.has(point)) {
    if (matches(pendingReleases.get(point), params)) {
      pendingReleases.delete(point);
      return;
    }
  }
  if (!armedHolds.has(point) || !matches(armedHolds.get(point), params)) return;
  armedHolds.delete(point);
  report({ type: "held", point, params });
  await new Promise((resolve) => {
    waitingHolds.set(point, { predicate: params, resolve });
  });
  report({ type: "released", point, params });
}

// Interrupt completion in controlled mode always waits for an explicit
// release, whether or not a hold was armed beforehand.
async function waitInterruptRelease(params) {
  if (pendingReleases.has("interrupt/completed")) {
    if (matches(pendingReleases.get("interrupt/completed"), params)) {
      pendingReleases.delete("interrupt/completed");
      return;
    }
  }
  report({ type: "held", point: "interrupt/completed", params });
  await new Promise((resolve) => {
    waitingHolds.set("interrupt/completed", { predicate: params, resolve });
  });
  report({ type: "released", point: "interrupt/completed", params });
}

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function requestFromClient(method, params) {
  const id = serverReqId++;
  return new Promise((resolve) => {
    pendingServerReqs.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

function completeTurn(threadId, turn, status, error) {
  const thread = threads.get(threadId);
  if (thread && thread.activeTurn === turn.id) thread.activeTurn = null;
  report({
    type: "turn/completed",
    threadId,
    turnId: turn.id,
    status,
    error: error ? error.message : null,
  });
  send({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId, turn: { id: turn.id, status, error, items: turn.items } },
  });
}

function emitDelta(threadId, turnId, delta) {
  send({
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: { threadId, turnId, delta },
  });
}

async function runApprovalScenario(threadId, turn, text) {
  const restrictive = process.env.DOT_FAKE_RESTRICTIVE === "1";
  const base = {
    itemId: `item_${generation}_${turn.id}`,
    startedAtMs: Date.now(),
    threadId,
    turnId: turn.id,
  };
  const summaries = [];

  const exec = await requestFromClient("item/commandExecution/requestApproval", {
    ...base,
    command: "echo approval-check",
    kind: "command",
  });
  if (!exec.result || exec.result.decision !== (restrictive ? "decline" : "accept")) {
    completeTurn(threadId, turn, "failed", {
      message: `invalid command approval reply: ${JSON.stringify(exec)}`,
    });
    return;
  }
  summaries.push(`exec=${exec.result.decision}`);

  const file = await requestFromClient("item/fileChange/requestApproval", base);
  if (!file.result || file.result.decision !== (restrictive ? "decline" : "accept")) {
    completeTurn(threadId, turn, "failed", {
      message: `invalid file change approval reply: ${JSON.stringify(file)}`,
    });
    return;
  }
  summaries.push(`file=${file.result.decision}`);

  if (text === "approvals-human") {
    const human = await requestFromClient("item/commandExecution/requestApproval", {
      ...base,
      itemId: `${base.itemId}_human`,
      command: "rm -rf /",
      kind: "humanCommand",
    });
    if (!human.result || human.result.decision !== "decline") {
      completeTurn(threadId, turn, "failed", {
        message: `humanCommand must be declined: ${JSON.stringify(human)}`,
      });
      return;
    }
    summaries.push(`human=${human.result.decision}`);
  }

  const perm = await requestFromClient("item/permissions/requestApproval", base);
  if (!perm.error || perm.error.code !== -32601) {
    completeTurn(threadId, turn, "failed", {
      message: `permission escalation must be rejected: ${JSON.stringify(perm)}`,
    });
    return;
  }
  summaries.push(`permErr=${perm.error.code}`);

  const input = await requestFromClient("item/tool/requestUserInput", base);
  if (!input.result || typeof input.result.answers !== "object" || input.result.answers === null) {
    completeTurn(threadId, turn, "failed", {
      message: `user input request must be answered: ${JSON.stringify(input)}`,
    });
    return;
  }
  summaries.push("input=ok");

  emitDelta(threadId, turn.id, summaries.join(" "));
  completeTurn(threadId, turn, "completed", null);
}

async function runTurnBody(threadId, turn, text) {
  if (text === "crash-mid-turn") {
    setTimeout(() => process.exit(1), 20);
    return;
  }

  if (text === "retry-then-ok") {
    send({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId,
        turnId: turn.id,
        willRetry: true,
        error: { message: "transient upstream failure", codexErrorInfo: null },
      },
    });
    emitDelta(threadId, turn.id, "echo: ");
    emitDelta(threadId, turn.id, text);
    completeTurn(threadId, turn, "completed", null);
    return;
  }

  if (text === "fail-final") {
    send({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId,
        turnId: turn.id,
        willRetry: false,
        error: { message: "final upstream failure", codexErrorInfo: null },
      },
    });
    completeTurn(threadId, turn, "failed", { message: "final upstream failure" });
    return;
  }

  if (text === "items-only") {
    turn.items.push({ type: "agentMessage", id: `${turn.id}_msg`, text: "items-only reply" });
    completeTurn(threadId, turn, "completed", null);
    return;
  }

  if (text === "long-running") {
    // Stays active until interrupted; used by interrupt/abort tests.
    return;
  }

  if (text === "slow-turn") {
    // Completes on its own after a short delay; used by disconnect tests.
    setTimeout(() => {
      emitDelta(threadId, turn.id, "echo: ");
      emitDelta(threadId, turn.id, text);
      completeTurn(threadId, turn, "completed", null);
    }, 300);
    return;
  }

  if (text === "complete-before-response") {
    // Terminal completion is emitted by startTurn before the RPC response.
    turn.items.push({ type: "agentMessage", id: `${turn.id}_msg`, text: "early reply" });
    turn.earlyComplete = true;
    return;
  }

  if (text === "approvals" || text === "approvals-human") {
    await runApprovalScenario(threadId, turn, text);
    return;
  }

  for (const delta of ["echo: ", text]) {
    emitDelta(threadId, turn.id, delta);
  }
  completeTurn(threadId, turn, "completed", null);
}

async function startTurn(id, params) {
  const thread = threads.get(params.threadId);
  if (!thread) {
    rpcError(id, -32602, `unknown thread: ${params.threadId}`);
    return;
  }
  if (thread.activeTurn) {
    rpcError(id, -32602, `turn already active on thread ${params.threadId}`);
    return;
  }
  const text = (params.input || []).map((part) => part.text).join(" ");
  await waitHold("turn/start", { ...params, text });
  const turnId = `turn_${generation}_${++turnCounter}`;
  const turn = { id: turnId, items: [] };
  thread.activeTurn = turnId;
  thread.turns.set(turnId, turn);
  report({ type: "turn/started", threadId: params.threadId, turnId, text });
  if (text === "no-turn-id") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  await runTurnBody(params.threadId, turn, text);
  if (turn.earlyComplete) {
    completeTurn(params.threadId, turn, "completed", null);
  }
  send({ jsonrpc: "2.0", id, result: { turn: { id: turnId } } });
}

function interruptTurn(id, params) {
  const thread = threads.get(params.threadId);
  if (!thread) {
    rpcError(id, -32602, `unknown thread: ${params.threadId}`);
    return;
  }
  const turn = thread.turns.get(params.turnId);
  if (!turn || thread.activeTurn !== params.turnId) {
    rpcError(id, -32602, `no active turn ${params.turnId} on thread ${params.threadId}`);
    return;
  }
  // Acknowledge immediately; the terminal "interrupted" completion follows
  // only after the test releases it (controlled mode) or right away.
  send({ jsonrpc: "2.0", id, result: {} });
  report({ type: "interrupt/ack", threadId: params.threadId, turnId: params.turnId });
  const finish = () => {
    if (thread.activeTurn === params.turnId) {
      completeTurn(params.threadId, turn, "interrupted", null);
    }
  };
  if (controlled) {
    waitInterruptRelease(params).then(finish);
    return;
  }
  finish();
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function handleRequest(message) {
  const { id, method, params } = message;
  report({ type: "request", id, method, params });
  if (method === "initialize") {
    await waitHold("initialize", params);
    send({ jsonrpc: "2.0", id, result: { userAgent: "fake-codex/0.0.0" } });
    return;
  }
  if (method === "initialized") return;
  if (method === "thread/start") {
    await waitHold("thread/start", params);
    const threadId = `thr_${generation}_${threads.size + 1}`;
    threads.set(threadId, {
      cwd: params.cwd,
      model: MODEL_ACTUAL || params.model || MODEL,
      activeTurn: null,
      turns: new Map(),
    });
    report({ type: "thread/created", threadId, params });
    send({
      jsonrpc: "2.0",
      id,
      result: {
        thread: { id: threadId },
        model: MODEL_ACTUAL || params.model || MODEL,
        cwd: params.cwd,
      },
    });
    return;
  }
  if (method === "turn/start") {
    await startTurn(id, params);
    return;
  }
  if (method === "turn/interrupt") {
    interruptTurn(id, params);
    return;
  }
  if (id !== undefined) {
    rpcError(id, -32601, `not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  await controlReady;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pendingServerReqs.get(message.id);
    if (resolve) {
      pendingServerReqs.delete(message.id);
      resolve(message);
    }
    return;
  }
  handleRequest(message).catch((error) => {
    process.stderr.write(`fake-codex: ${error.stack || error}\n`);
    process.exit(1);
  });
});

process.stdin.on("end", () => process.exit(0));