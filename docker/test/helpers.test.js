import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  allowedOrigin,
  authorized,
  contentToText,
  conversationIdFor,
  hostAllowed,
  normalizeMessages,
  parseLastJson,
  validateCwd,
} from "../server.js";

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
    // Explicit workspace parameter for isolated testing.
    assert.equal(validateCwd(undefined, "/srv/ws"), "/srv/ws");
    assert.equal(validateCwd("/srv/ws/sub", "/srv/ws"), "/srv/ws/sub");
    assert.throws(() => validateCwd("/srv/other", "/srv/ws"), /cwd must be inside \/srv\/ws/);
  });

  test("conversationIdFor honours the documented precedence", () => {
    const req = (headers = {}) => ({ headers });
    assert.equal(
      conversationIdFor({ conversation_id: "a", metadata: { conversation_id: "b" }, user: "u" }, req({ "x-conversation-id": "h" })),
      "a",
    );
    assert.equal(
      conversationIdFor({ metadata: { conversation_id: "b" }, user: "u" }, req({ "x-conversation-id": "h" })),
      "b",
    );
    assert.equal(conversationIdFor({ user: "u" }, req({ "x-conversation-id": "h" })), "h");
    assert.equal(conversationIdFor({ user: "u" }, req()), "u");
  });

  test("conversationIdFor rejects invalid ids and never shares a default", () => {
    const req = () => ({ headers: {} });
    for (const bad of ["", 42, {}, []]) {
      assert.throws(
        () => conversationIdFor({ conversation_id: bad }, req()),
        /conversation id must be a non-empty string/,
      );
    }
    assert.throws(
      () => conversationIdFor({ metadata: { conversation_id: "" } }, req()),
      /non-empty string/,
    );
    const first = conversationIdFor({}, req());
    const second = conversationIdFor({}, req());
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.notEqual(first, second);
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