import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSseSuccess, startBridge, waitFor } from "./support/harness.mjs";

describe("HTTP bridge against a fake codex", () => {
  test("health reports the fake codex", async (t) => {
    const bridge = await startBridge(t);
    const data = await (await bridge.get("/health")).json();
    assert.equal(data.ok, true);
    assert.match(data.codex.version, /fake/);
    assert.equal(data.auth.loggedIn, false);
  });

  test("chat completions returns the agent reply", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat/completions", {
      conversation_id: "t1",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.choices[0].message.content, "echo: hello");
    assert.equal(data.conversation_id, "t1");
  });

  test("concurrent requests share one thread and serialize turns", async (t) => {
    const bridge = await startBridge(t);
    // Hold turn B at turn/start so we can prove it does not start while A
    // is active, and only after A's terminal completion.
    bridge.control.hold("turn/start", { text: "two" });
    const pa = bridge.post("/v1/chat", { conversation_id: "concurrent", input: "one" });
    const pb = bridge.post("/v1/chat", { conversation_id: "concurrent", input: "two" });

    await bridge.control.waitFor(
      (event) => event.type === "turn/started" && event.text === "one",
      { label: "turn A start" },
    );
    const heldB = await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "turn/start",
      { label: "turn B held" },
    );
    // Only A may have started so far, and B's hold must come after A finished.
    const started = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.deepEqual(started.map((event) => event.text), ["one"]);
    const completedA = bridge.control.events.findIndex(
      (event) => event.type === "turn/completed" && event.status === "completed",
    );
    const heldIndex = bridge.control.events.indexOf(heldB);
    assert.ok(completedA >= 0, "turn A completed");
    assert.ok(heldIndex > completedA, "turn B must not start before A completes");

    bridge.control.release("turn/start");
    const [a, b] = await Promise.all([pa.then((r) => r.json()), pb.then((r) => r.json())]);
    assert.equal(a.thread_id, b.thread_id);
    assert.equal(a.reply, "echo: one");
    assert.equal(b.reply, "echo: two");
    const allStarted = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.deepEqual(allStarted.map((event) => event.text), ["one", "two"]);
  });

  test("streaming emits a complete SSE stream ending in [DONE]", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "stream" }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const text = await res.text();
    assertSseSuccess(text, "echo: stream");
  });

  test("pairing parses the last JSON line", async (t) => {
    const bridge = await startBridge(t);
    const data = await (
      await fetch(`${bridge.baseUrl}/v1/remote/pair`, { method: "POST" })
    ).json();
    assert.equal(data.manualPairingCode, "TEST-CODE");
  });

  test("non-JSON and non-object bodies are rejected", async (t) => {
    const bridge = await startBridge(t);
    const plain = await fetch(`${bridge.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ input: "x" }),
    });
    assert.equal(plain.status, 415);

    const arr = await fetch(`${bridge.baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(arr.status, 400);
  });

  test("cross-origin browser requests are rejected", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post(
      "/v1/chat",
      { input: "x" },
      { Origin: "https://evil.example" },
    );
    assert.equal(res.status, 403);
  });

  test("cwd outside the workspace is rejected", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "cwd",
      cwd: "/etc",
      input: "x",
    });
    assert.equal(res.status, 400);
  });

  test("V2 approvals are accepted only in the automatic configuration", async (t) => {
    const bridge = await startBridge(t);
    // The fake only completes successfully when every approval reply is
    // valid per the pinned 0.167.0 schema (decision accept/decline).
    const res = await bridge.post("/v1/chat", {
      conversation_id: "approvals",
      input: "approvals",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "exec=accept file=accept permErr=-32601 input=ok");
  });

  test("restrictive configuration declines command and file approvals", async (t) => {
    const bridge = await startBridge(t, {
      env: {
        DOT_APPROVAL_POLICY: "on-request",
        DOT_SANDBOX: "workspace-write",
        DOT_FAKE_RESTRICTIVE: "1",
      },
    });
    const res = await bridge.post("/v1/chat", {
      conversation_id: "approvals-restrictive",
      input: "approvals",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "exec=decline file=decline permErr=-32601 input=ok");
  });

  test("humanCommand approvals are always declined", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "approvals-human",
      input: "approvals-human",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(
      data.reply,
      "exec=accept file=accept human=decline permErr=-32601 input=ok",
    );
  });

  test("retryable error notifications do not end the request", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "retry",
      input: "retry-then-ok",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "echo: retry-then-ok");
  });

  test("final error notifications surface a readable 502 message", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "fail",
      input: "fail-final",
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.error, "final upstream failure");
  });

  test("terminal text can arrive exclusively in turn items", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", {
      conversation_id: "items",
      input: "items-only",
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reply, "items-only reply");
  });

  test("response model comes from thread/start, not the request", async (t) => {
    const bridge = await startBridge(t, {
      env: { DOT_FAKE_MODEL_ACTUAL: "resolved-actual-model" },
    });
    const res = await bridge.post("/v1/chat/completions", {
      conversation_id: "model",
      model: "requested-alias",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.model, "resolved-actual-model");
    assert.equal(data.usage, undefined);
  });

  test("requests without an id get independent conversations", async (t) => {
    const bridge = await startBridge(t);
    const a = await (await bridge.post("/v1/chat", { input: "one" })).json();
    const b = await (await bridge.post("/v1/chat", { input: "two" })).json();
    assert.notEqual(a.conversation_id, b.conversation_id);
    assert.notEqual(a.thread_id, b.thread_id);
  });

  test("same id reuses the thread and serializes turns", async (t) => {
    const bridge = await startBridge(t);
    const a = await (await bridge.post("/v1/chat", { conversation_id: "same", input: "one" })).json();
    const b = await (await bridge.post("/v1/chat", { conversation_id: "same", input: "two" })).json();
    assert.equal(a.thread_id, b.thread_id);
    assert.equal(a.conversation_id, "same");
    const starts = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.deepEqual(starts.map((event) => event.text), ["one", "two"]);
  });

  test("changed model on an existing conversation is a 409 without a turn", async (t) => {
    const bridge = await startBridge(t);
    const first = await bridge.post("/v1/chat/completions", {
      conversation_id: "cfg",
      model: "model-a",
      messages: [{ role: "user", content: "one" }],
    });
    assert.equal(first.status, 200);
    const conflict = await bridge.post("/v1/chat/completions", {
      conversation_id: "cfg",
      model: "model-b",
      messages: [{ role: "user", content: "two" }],
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /configuration conflict/);
    const starts = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.equal(starts.length, 1, "conflicting request must not start a turn");
    // Identical or omitted model continues the conversation.
    const same = await bridge.post("/v1/chat/completions", {
      conversation_id: "cfg",
      model: "model-a",
      messages: [{ role: "user", content: "three" }],
    });
    assert.equal(same.status, 200);
    const omitted = await bridge.post("/v1/chat/completions", {
      conversation_id: "cfg",
      messages: [{ role: "user", content: "four" }],
    });
    assert.equal(omitted.status, 200);
    assert.equal((await omitted.json()).model, "model-a");
  });

  test("model alias resolving to the actual model is accepted", async (t) => {
    const bridge = await startBridge(t, {
      env: { DOT_FAKE_MODEL_ACTUAL: "actual-model" },
    });
    const first = await bridge.post("/v1/chat", {
      conversation_id: "alias",
      model: "alias-name",
      input: "one",
    });
    assert.equal(first.status, 200);
    // The actual response model is an accepted alias for the same thread.
    const second = await bridge.post("/v1/chat", {
      conversation_id: "alias",
      model: "actual-model",
      input: "two",
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).thread_id, (await first.json()).thread_id);
  });

  test("changed cwd or instructions on an existing conversation is a 409", async (t) => {
    const bridge = await startBridge(t);
    const first = await bridge.post("/v1/chat", {
      conversation_id: "cfg2",
      cwd: `${bridge.workspace}/sub`,
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "one" },
      ],
    });
    assert.equal(first.status, 200);
    const cwdConflict = await bridge.post("/v1/chat", {
      conversation_id: "cfg2",
      cwd: bridge.workspace,
      input: "two",
    });
    assert.equal(cwdConflict.status, 409);
    const instrConflict = await bridge.post("/v1/chat", {
      conversation_id: "cfg2",
      messages: [
        { role: "system", content: "be verbose" },
        { role: "user", content: "two" },
      ],
    });
    assert.equal(instrConflict.status, 409);
    // Omitted settings inherit and continue.
    const ok = await bridge.post("/v1/chat", { conversation_id: "cfg2", input: "three" });
    assert.equal(ok.status, 200);
    const starts = bridge.control.events.filter((event) => event.type === "turn/started");
    assert.equal(starts.length, 2);
  });

  test("invalid messages on an existing thread are 400 even with stream", async (t) => {
    const bridge = await startBridge(t);
    const first = await bridge.post("/v1/chat", { conversation_id: "valid", input: "one" });
    assert.equal(first.status, 200);
    const bad = await bridge.post("/v1/chat/completions", {
      conversation_id: "valid",
      stream: true,
      messages: [],
    });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type"), /application\/json/);
    assert.match((await bad.json()).error, /user message/);
  });

  test("invalid conversation id is a 400", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat", { conversation_id: "", input: "x" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /non-empty string/);
  });

  test("SSE exposes a reusable conversation id header", async (t) => {
    const bridge = await startBridge(t);
    const res = await bridge.post("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "stream-id" }],
    });
    assert.equal(res.status, 200);
    const conversationId = res.headers.get("x-conversation-id");
    assert.ok(conversationId, "SSE must expose X-Conversation-Id");
    await res.text();
    const reuse = await bridge.post("/v1/chat", { conversation_id: conversationId, input: "again" });
    assert.equal(reuse.status, 200);
    const data = await reuse.json();
    assert.equal(data.conversation_id, conversationId);
    const created = bridge.control.events.filter((event) => event.type === "thread/created");
    assert.equal(created.length, 1, "reused id must not create a second thread");
  });
});

describe("liveness, readiness and remote state", () => {
  test("livez is 200 before the child initializes; readyz is 503", async (t) => {
    const bridge = await startBridge(t, { holds: [{ point: "initialize" }] });
    await bridge.control.waitFor(
      (event) => event.type === "held" && event.point === "initialize",
      { label: "initialize held" },
    );
    const live = await bridge.get("/livez");
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });
    const ready = await bridge.get("/readyz");
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { ready: false });
    const health = await (await bridge.get("/health")).json();
    assert.equal(health.appServer.ready, false);
    bridge.control.release("initialize");
    await bridge.waitReady();
  });

  test("without auth the initialized child is still not ready", async (t) => {
    const bridge = await startBridge(t);
    await bridge.waitReady();
    const ready = await bridge.get("/readyz");
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { ready: false });
    // Diagnostics stay reachable and report the split state.
    const health = await bridge.get("/health");
    assert.equal(health.status, 200);
    const data = await health.json();
    assert.equal(data.ready, false);
    assert.equal(data.appServer.ready, true);
  });

  test("initialized child plus synthetic auth makes readyz 200", async (t) => {
    const bridge = await startBridge(t);
    await bridge.waitReady();
    await writeFile(
      path.join(bridge.codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
    );
    const ready = await bridge.get("/readyz");
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true });
    const health = await (await bridge.get("/health")).json();
    assert.equal(health.ready, true);
    assert.equal(health.auth.loggedIn, true);
  });

  test("auth_mode chatgpt without a token is not ready", async (t) => {
    const bridge = await startBridge(t);
    await bridge.waitReady();
    await writeFile(
      path.join(bridge.codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: {} }),
    );
    const ready = await bridge.get("/readyz");
    assert.equal(ready.status, 503);
  });

  test("child loss drops readyz to 503 and recovery restores it", async (t) => {
    const bridge = await startBridge(t);
    await bridge.waitReady();
    await writeFile(
      path.join(bridge.codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-test" }),
    );
    assert.equal((await bridge.get("/readyz")).status, 200);
    // Crash the child mid-turn.
    const crash = await bridge.post("/v1/chat", { conversation_id: "probe-crash", input: "crash-mid-turn" });
    assert.equal(crash.status, 502);
    const down = await bridge.get("/readyz");
    assert.equal(down.status, 503);
    assert.equal((await bridge.get("/livez")).status, 200);
    await bridge.waitReady(2, 15000);
    await waitFor(async () => (await bridge.get("/readyz")).status === 200, "readyz recovery", 10000);
  }, { timeout: 25000 });

  test("probes never spawn additional CLI children", async (t) => {
    const bridge = await startBridge(t);
    await bridge.waitReady();
    const before = bridge.control.events.filter(
      (event) => event.type === "request" && event.method === "initialize",
    ).length;
    for (let i = 0; i < 5; i += 1) {
      await bridge.get("/livez");
      await bridge.get("/readyz");
      await bridge.get("/health");
    }
    const after = bridge.control.events.filter(
      (event) => event.type === "request" && event.method === "initialize",
    ).length;
    assert.equal(after, before, "probes must not restart or spawn children");
    // The fake only sees app-server RPCs; a --version subprocess would not
    // show here, so also check the health version is served from cache.
    const health = await (await bridge.get("/health")).json();
    assert.match(health.codex.version, /fake/);
  });

  test("stale remote status never reports connected", async (t) => {
    const bridge = await startBridge(t);
    const statusFile = path.join(bridge.codexHome, "dot-remote-status.json");
    const old = new Date(Date.now() - 120_000).toISOString();
    await writeFile(statusFile, JSON.stringify({ status: "connected", checkedAt: old }));
    let health = await (await bridge.get("/health")).json();
    assert.equal(health.remote.connected, false);
    assert.equal(health.remote.status, "stale");
    assert.equal(health.remote.checkedAt, old);
    // Fresh timestamp: connected.
    await writeFile(statusFile, JSON.stringify({ status: "connected", checkedAt: new Date().toISOString() }));
    health = await (await bridge.get("/health")).json();
    assert.equal(health.remote.connected, true);
    assert.equal(health.remote.status, "connected");
    // Future timestamp: not trusted.
    const future = new Date(Date.now() + 120_000).toISOString();
    await writeFile(statusFile, JSON.stringify({ status: "connected", checkedAt: future }));
    health = await (await bridge.get("/health")).json();
    assert.equal(health.remote.connected, false);
    // Missing/invalid file: unknown.
    await writeFile(statusFile, "not json");
    health = await (await bridge.get("/health")).json();
    assert.equal(health.remote.connected, false);
    assert.equal(health.remote.status, "unknown");
  });

  test("probes are exempt from the bearer token but not host checks", async (t) => {
    const bridge = await startBridge(t, { env: { DOT_API_KEY: "secret" } });
    assert.equal((await bridge.get("/livez")).status, 200);
    assert.equal((await bridge.get("/readyz")).status, 503);
    assert.equal((await bridge.get("/health")).status, 200);
    const chat = await bridge.post("/v1/chat", { input: "x" });
    assert.equal(chat.status, 401);
    // Host checks only apply without an API key (with a key, remote access
    // is intentionally allowed). Use a second keyless bridge.
    const keyless = await startBridge(t);
    const { request: httpRequest } = await import("node:http");
    const { port } = new URL(keyless.baseUrl);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/livez", headers: { Host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
  });
});