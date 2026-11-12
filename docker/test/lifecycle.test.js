import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseSse, startBridge, waitFor } from "./support/harness.mjs";

describe("app-server lifecycle", () => {
  test("app-server exit mid-turn aborts immediately instead of hanging", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "crash",
      input: "crash-mid-turn",
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /exited/);
  });

  test("interrupted turns end as HTTP 409", async (t) => {
    const bridge = await startBridge(t);
    const chat = bridge.post("/v1/chat", {
      conversation_id: "interrupt-json",
      input: "long-running",
    });
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    const interrupt = bridge.post("/v1/interrupt", {
      thread_id: started.threadId,
    });
    // The fake holds the terminal completion; the interrupt endpoint must
    // stay open until it is released.
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt completion held" },
    );
    bridge.control.release("interrupt/completed");
    assert.equal((await interrupt).status, 200);
    const res = await chat;
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.error, "turn interrupted");
  });

  test("interrupted SSE streams end with an error frame, never stop", async (t) => {
    const bridge = await startBridge(t);
    const chat = bridge.post("/v1/chat/completions", {
      conversation_id: "interrupt-sse",
      stream: true,
      messages: [{ role: "user", content: "long-running" }],
    });
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    const interrupt = bridge.post("/v1/interrupt", {
      thread_id: started.threadId,
    });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt completion held" },
    );
    bridge.control.release("interrupt/completed");
    assert.equal((await interrupt).status, 200);
    const res = await chat;
    assert.equal(res.status, 200);
    const frames = parseSse(await res.text()).filter((frame) => !frame.comment);
    assert.deepEqual(frames[frames.length - 1], { done: true });
    const errorFrames = frames.filter((frame) => frame.data && frame.data.error);
    assert.equal(errorFrames.length, 1);
    assert.equal(errorFrames[0].data.error.message, "turn interrupted");
    const stopFrames = frames.filter(
      (frame) => frame.data?.choices?.[0]?.finish_reason === "stop",
    );
    assert.equal(stopFrames.length, 0, "interrupted stream must not finish with stop");
  });

  test("completion before the start response is applied via the confirmed id", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "early",
      input: "complete-before-response",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "early reply");
  });

  test("disconnect during thread creation never starts a turn", async (t) => {
    const bridge = await startBridge(t);
    bridge.control.hold("thread/start");
    const controller = new AbortController();
    const chat = fetch(`${bridge.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "disc-create", input: "hello" }),
      signal: controller.signal,
    }).catch((error) => error);
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "thread/start",
      { label: "thread creation held" },
    );
    controller.abort();
    await chat;
    bridge.control.release("thread/start");
    // The shared thread creation finishes, but the aborted waiter must not
    // produce any turn work.
    await bridge.control.waitFor(
      (event) => event.type === "thread/created",
      { label: "thread created" },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const turnStarts = bridge.control.events.filter(
      (event) => event.type === "request" && event.method === "turn/start",
    );
    assert.equal(turnStarts.length, 0, "aborted waiter must not start a turn");
  });

  test("a waiting request that disconnects never starts its turn", async (t) => {
    const bridge = await startBridge(t);
    // Turn A runs long; B queues behind it; B's client disconnects; C then
    // runs normally. B must never produce a turn/start.
    const pa = bridge.post("/v1/chat", { conversation_id: "queue", input: "long-running" });
    const startedA = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn A start" },
    );
    const controllerB = new AbortController();
    const pb = fetch(`${bridge.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "queue", input: "B-request" }),
      signal: controllerB.signal,
    }).catch((error) => error);
    // Give B time to enter the queue behind A.
    await new Promise((resolve) => setTimeout(resolve, 100));
    controllerB.abort();
    await pb;
    const pc = bridge.post("/v1/chat", { conversation_id: "queue", input: "C-request" });
    // Let A finish via interrupt; then C must run.
    const interrupt = bridge.post("/v1/interrupt", { thread_id: startedA.threadId });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    bridge.control.release("interrupt/completed");
    assert.equal((await interrupt).status, 200);
    assert.equal((await pa).status, 409);
    const resC = await pc;
    assert.equal(resC.status, 200);
    assert.equal((await resC.json()).reply, "echo: C-request");
    const turnTexts = bridge.control.events
      .filter((event) => event.type === "turn/started")
      .map((event) => event.text);
    assert.deepEqual(turnTexts, ["long-running", "C-request"], "B never started a turn");
  });

  test("disconnecting a running JSON request cancels the turn", async (t) => {
    const bridge = await startBridge(t);
    const controller = new AbortController();
    const chat = fetch(`${bridge.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: "disc-json", input: "long-running" }),
      signal: controller.signal,
    }).catch((error) => error);
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    controller.abort();
    await chat;
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    bridge.control.release("interrupt/completed");
    const completed = await bridge.control.waitFor(
      (event) => event.type === "turn/completed" && event.turnId === started.turnId,
      { label: "turn completed" },
    );
    assert.equal(completed.status, "interrupted");
    // The thread is free again: a new turn can run.
    const res = await bridge.post("/v1/chat", { conversation_id: "disc-json", input: "after" });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, "echo: after");
  });

  test("disconnecting a running SSE request cancels the turn", async (t) => {
    const bridge = await startBridge(t);
    const controller = new AbortController();
    const chat = fetch(`${bridge.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversation_id: "disc-sse",
        stream: true,
        messages: [{ role: "user", content: "long-running" }],
      }),
      signal: controller.signal,
    }).catch((error) => error);
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    controller.abort();
    await chat;
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    bridge.control.release("interrupt/completed");
    const completed = await bridge.control.waitFor(
      (event) => event.type === "turn/completed" && event.turnId === started.turnId,
      { label: "turn completed" },
    );
    assert.equal(completed.status, "interrupted");
  });

  test("no second turn starts before a delayed interrupt completes", async (t) => {
    const bridge = await startBridge(t);
    const pa = bridge.post("/v1/chat", { conversation_id: "delayed", input: "long-running" });
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    const interrupt = bridge.post("/v1/interrupt", { thread_id: started.threadId });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    // While the interrupt completion is withheld, a new request must queue.
    const pb = bridge.post("/v1/chat", { conversation_id: "delayed", input: "next" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const starts = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.equal(starts.length, 1, "no parallel turn while interrupt is open");
    bridge.control.release("interrupt/completed");
    assert.equal((await interrupt).status, 200);
    assert.equal((await pa).status, 409);
    const resB = await pb;
    assert.equal(resB.status, 200);
    assert.equal((await resB.json()).reply, "echo: next");
  });

  test("missing interrupt completion invalidates the generation within the recovery window", async (t) => {
    const bridge = await startBridge(t);
    const pa = bridge.post("/v1/chat", { conversation_id: "stuck", input: "long-running" });
    const started = await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "long-running",
      { label: "turn start" },
    );
    const interrupt = bridge.post("/v1/interrupt", { thread_id: started.threadId });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    // Never release: the bridge must reset the generation, not run parallel
    // agent work. Recovery window is 10 s.
    const resA = await pa;
    assert.equal(resA.status, 502);
    const resI = await interrupt;
    assert.equal(resI.status, 502);
    await bridge.waitReady(2, 15000);
    const resC = await bridge.post("/v1/chat", { conversation_id: "stuck", input: "fresh" });
    assert.equal(resC.status, 200);
    assert.equal((await resC.json()).reply, "echo: fresh");
  }, { timeout: 20000 });

  test("crash with active and waiting requests: controlled errors, then recovery", async (t) => {
    const bridge = await startBridge(t);
    const pa = bridge.post("/v1/chat", { conversation_id: "crashq", input: "crash-mid-turn" });
    await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "crash-mid-turn",
      { label: "turn start" },
    );
    const pb = bridge.post("/v1/chat", { conversation_id: "crashq", input: "waiting" });
    const [resA, resB] = await Promise.all([pa, pb]);
    assert.equal(resA.status, 502);
    assert.equal(resB.status, 502);
    assert.match((await resA.json()).error, /exited/);
    // After recovery a fresh request works on a new thread of the new child.
    await bridge.waitReady(2, 15000);
    const resC = await bridge.post("/v1/chat", { conversation_id: "crashq", input: "recovered" });
    assert.equal(resC.status, 200);
    const dataC = await resC.json();
    assert.equal(dataC.reply, "echo: recovered");
    const created = bridge.control.events.filter((event) => event.type === "thread/created");
    assert.ok(created.length >= 2, "a new thread was created in the new generation");
    assert.notEqual(created[0].threadId, created[created.length - 1].threadId);
  }, { timeout: 20000 });

  test("unstartable CODEX_BIN keeps the API diagnostic and recovers when fixed", async (t) => {
    const fs = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await fs.mkdtemp(path.join(tmpdir(), "dot-bin-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const lateBin = path.join(dir, "codex");
    const bridge = await startBridge(t, { env: { CODEX_BIN: lateBin } });
    // HTTP stays up and reports the failure instead of hanging.
    const health = await bridge.get("/health");
    assert.equal(health.status, 200);
    const chat = await bridge.post("/v1/chat", { input: "x" });
    assert.equal(chat.status, 502);
    assert.match((await chat.json()).error, /spawn|ENOENT|not running/i);
    assert.equal(bridge.exited, false, "bridge must not crash on spawn errors");
    // Restore the executable: the supervisor must recover on its own.
    const { FAKE_CODEX } = await import("./support/harness.mjs");
    await fs.symlink(FAKE_CODEX, lateBin);
    await bridge.waitReady(1, 20000);
    const recovered = await bridge.post("/v1/chat", { input: "back" });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).reply, "echo: back");
  }, { timeout: 30000 });

  test("turn timeout returns 504 and frees the thread", async (t) => {
    const bridge = await startBridge(t, { env: { DOT_TURN_TIMEOUT_MS: "500" } });
    const res = bridge.post("/v1/chat", { conversation_id: "timeout", input: "long-running" });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "interrupt/completed",
      { label: "interrupt held" },
    );
    bridge.control.release("interrupt/completed");
    const final = await res;
    assert.equal(final.status, 504);
    assert.equal((await final.json()).error, "turn timed out");
    await bridge.control.waitFor(
      (event) => event.type === "turn/completed" && event.status === "interrupted",
      { label: "turn completed" },
    );
    const after = await bridge.post("/v1/chat", { conversation_id: "timeout", input: "after" });
    assert.equal(after.status, 200);
  }, { timeout: 20000 });
});