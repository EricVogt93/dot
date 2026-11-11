import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allowedOrigin,
  authorized,
  contentToText,
  hostAllowed,
  normalizeMessages,
  parseLastJson,
  validateCwd,
} from "../server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("helpers", () => {
  test("contentToText joins text parts and rejects others", () => {
    assert.equal(contentToText("hi"), "hi");
    assert.equal(contentToText(["a", { type: "text", text: "b" }]), "a\nb");
    assert.throws(() => contentToText([{ type: "image_url" }]), /Only text/);
  });

  test("normalizeMessages keeps system text and the last user message", () => {
    const result = normalizeMessages({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "assistant", content: "x" },
        { role: "user", content: "second" },
      ],
    });
    assert.deepEqual(result, { system: "sys", lastUser: "second" });
    assert.throws(() => normalizeMessages({ messages: [] }), /user message/);
  });

  test("validateCwd stays inside the workspace and rejects invalid input", () => {
    const root = validateCwd();
    assert.equal(validateCwd(path.join(root, "a")), path.join(root, "a"));
    assert.throws(() => validateCwd("/etc"), /cwd must be inside/);
    assert.throws(() => validateCwd(`${root}-other`), /cwd must be inside/);
    assert.throws(() => validateCwd(123), /valid path string/);
    assert.throws(() => validateCwd(`${root}/a\0b`), /valid path string/);
  });

  test("parseLastJson returns the last JSON line", () => {
    assert.deepEqual(parseLastJson('noise\n{"a":1}\n{"b":2}\n'), { b: 2 });
    assert.throws(() => parseLastJson("none"), /no JSON/);
  });

  test("authorized checks bearer tokens except on /health", () => {
    const url = (p) => new URL(p, "http://localhost");
    const req = (auth) => ({ headers: auth ? { authorization: auth } : {} });
    assert.equal(authorized(req(), url("/v1/chat"), ""), true);
    assert.equal(authorized(req(), url("/health"), "k"), true);
    assert.equal(authorized(req(), url("/v1/chat"), "k"), false);
    assert.equal(authorized(req("Bearer x"), url("/v1/chat"), "k"), false);
    assert.equal(authorized(req("Bearer k"), url("/v1/chat"), "k"), true);
  });

  test("hostAllowed only accepts loopback hosts without an API key", () => {
    const req = (host) => ({ headers: host ? { host } : {} });
    assert.equal(hostAllowed(req("127.0.0.1:8787"), ""), true);
    assert.equal(hostAllowed(req("localhost"), ""), true);
    assert.equal(hostAllowed(req("[::1]:8787"), ""), true);
    assert.equal(hostAllowed(req("[::1"), ""), false);
    assert.equal(hostAllowed(req(""), ""), false);
    assert.equal(hostAllowed(req("evil.example:8787"), ""), false);
    assert.equal(hostAllowed(req("evil.example:8787"), "k"), true);
  });

  test("allowedOrigin honours the allow-list", () => {
    assert.equal(allowedOrigin(undefined, [], ""), null);
    assert.equal(allowedOrigin("https://a.example", [], ""), null);
    assert.equal(
      allowedOrigin("https://a.example", ["https://a.example"], ""),
      "https://a.example",
    );
    assert.equal(allowedOrigin("https://b.example", ["*"], ""), null);
    assert.equal(allowedOrigin("https://b.example", ["*"], "k"), "*");
  });
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe("HTTP bridge against a fake codex", () => {
  let child;
  let tmp;
  let base;

  before(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "dot-test-"));
    const fake = path.join(here, "fake-codex.mjs");
    await chmod(fake, 0o755);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(here, "..", "server.js")], {
      env: {
        ...process.env,
        CODEX_BIN: fake,
        CODEX_HOME: tmp,
        DOT_WORKSPACE: tmp,
        DOT_API_PORT: String(port),
        DOT_BIND: "127.0.0.1",
        DOT_API_KEY: "",
        DOT_CORS_ORIGINS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("server did not start");
  });

  after(async () => {
    child?.kill("SIGTERM");
    await rm(tmp, { recursive: true, force: true });
  });

  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  test("health reports the fake codex", async () => {
    const data = await (await fetch(`${base}/health`)).json();
    assert.equal(data.ok, true);
    assert.match(data.codex.version, /fake/);
    assert.equal(data.auth.loggedIn, false);
  });

  test("chat completions returns the agent reply", async () => {
    const res = await post("/v1/chat/completions", {
      conversation_id: "t1",
      messages: [{ role: "user", content: "hello" }],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.choices[0].message.content, "echo: hello");
    assert.equal(data.conversation_id, "t1");
  });

  test("concurrent requests for the same conversation share one thread", async () => {
    const [a, b] = await Promise.all([
      post("/v1/chat", { conversation_id: "concurrent", input: "one" }).then((r) =>
        r.json(),
      ),
      post("/v1/chat", { conversation_id: "concurrent", input: "two" }).then((r) =>
        r.json(),
      ),
    ]);
    assert.equal(a.thread_id, b.thread_id);
    assert.equal(a.reply, "echo: one");
    assert.equal(b.reply, "echo: two");
  });

  test("streaming emits SSE chunks and [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      stream: true,
      messages: [{ role: "user", content: "stream" }],
    });
    const text = await res.text();
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.match(text, /"content":"stream"/);
    assert.match(text, /data: \[DONE\]/);
  });

  test("server approval requests get valid JSON-RPC result and error replies", async () => {
    const res = await post("/v1/chat", {
      conversation_id: "approvals",
      input: "check-approvals",
    });
    const data = await res.json();
    assert.equal(data.reply, "exec=approved permErr=-32601");
  });

  test("pairing parses the last JSON line", async () => {
    const data = await (
      await fetch(`${base}/v1/remote/pair`, { method: "POST" })
    ).json();
    assert.equal(data.manualPairingCode, "TEST-CODE");
  });

  test("non-JSON and non-object bodies are rejected", async () => {
    const plain = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ input: "x" }),
    });
    assert.equal(plain.status, 415);

    const arr = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[]",
    });
    assert.equal(arr.status, 400);
  });

  test("cross-origin browser requests are rejected", async () => {
    const res = await post(
      "/v1/chat",
      { input: "x" },
      { Origin: "https://evil.example" },
    );
    assert.equal(res.status, 403);
  });

  test("cwd outside the workspace is rejected", async () => {
    const res = await post("/v1/chat", {
      conversation_id: "cwd",
      cwd: "/etc",
      input: "x",
    });
    assert.equal(res.status, 400);
  });

  test("app-server exit mid-turn aborts immediately instead of hanging", async () => {
    const res = await post("/v1/chat", {
      conversation_id: "crash",
      input: "crash-mid-turn",
    });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /exited/);
  });
});
