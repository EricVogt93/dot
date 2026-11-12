// Image smoke test: runs INSIDE the built dot image (node, no network, no
// auth). Verifies the real bundled Codex runtime, the app-server handshake,
// runtime seeding against the contained seed, and the pinned protocol
// contract via `codex app-server generate-json-schema`.
//
// Executed by verify-image.sh through `docker create --network none`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEED_CODEX = "/opt/codex-seed/packages/standalone/current/bin/codex";
const here = path.dirname(fileURLToPath(import.meta.url));
const dockerDir = path.join(here, "..");

function run(bin, args, { timeoutMs = 30000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${bin} ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 1. The bundled CLI works without auth or network.
// ---------------------------------------------------------------------------
async function testVersion() {
  const { code, stdout } = await run(SEED_CODEX, ["--version"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^codex-cli \d+\.\d+\.\d+/);
  console.log(`ok: codex --version -> ${stdout.trim()}`);
}

// ---------------------------------------------------------------------------
// 2. app-server handshake and clean start/stop over stdio.
// ---------------------------------------------------------------------------
async function testAppServerHandshake() {
  const home = await mkdtemp(path.join(tmpdir(), "dot-image-home-"));
  try {
    const child = spawn(SEED_CODEX, ["app-server", "--listen", "stdio://"], {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const responses = new Map();
    const waiters = new Map();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== undefined && message.method === undefined) {
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message);
          } else {
            responses.set(message.id, message);
          }
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const request = (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
        const deliver = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        if (responses.has(id)) {
          deliver(responses.get(id));
          responses.delete(id);
        } else {
          waiters.set(id, deliver);
        }
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });

    try {
      const init = await request(1, "initialize", {
        clientInfo: { name: "dot-image-test", title: "dot image test", version: "0.0.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      assert.ok(init.result, `initialize failed: ${JSON.stringify(init)} stderr=${stderr}`);
      assert.ok(init.result.userAgent, "initialize must report a userAgent");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`);
      console.log(`ok: app-server handshake (${init.result.userAgent})`);
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
      const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(false);
        }, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      assert.ok(exited, "app-server must stop on stdin close/SIGTERM");
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Runtime seeding against the seed actually contained in the image.
// ---------------------------------------------------------------------------
async function testRuntimeSeeding() {
  const root = await mkdtemp(path.join(tmpdir(), "dot-image-seed-"));
  try {
    const codexHome = path.join(root, "data");
    const snippet = `
      set -Eeuo pipefail
      export CODEX_HOME="${codexHome}"
      unset CODEX_BIN || true
      source "${dockerDir}/entrypoint.sh"
      seed_runtime /opt/codex-seed "${codexHome}"
      "${codexHome}/packages/standalone/current/bin/codex" --version
      command -v codex
    `;
    const { code, stdout, stderr } = await run("bash", ["-c", snippet], {
      env: { CODEX_HOME: codexHome },
    });
    assert.equal(code, 0, `seed_runtime failed: ${stderr}`);
    assert.match(stdout, /codex-cli \d+\.\d+\.\d+/);
    assert.ok(
      stdout.includes(`${codexHome}/packages/standalone/current/bin/codex`),
      "PATH must resolve codex to the seeded active runtime",
    );
    // Second run reuses the release (idempotent).
    const again = await run("bash", ["-c", snippet], { env: { CODEX_HOME: codexHome } });
    assert.equal(again.code, 0, again.stderr);
    console.log("ok: runtime seeding from the contained image seed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4. Independent contract check against the CLI's own generated schemas.
// ---------------------------------------------------------------------------

// Canonical JSON for deduplicating identical schema occurrences.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function collectSchemas(dir) {
  const byTitle = new Map(); // title -> Map(canonical -> schema)
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".json")) {
        let schema;
        try {
          schema = JSON.parse(await readFile(full, "utf8"));
        } catch {
          continue;
        }
        const title = schema && schema.title;
        if (typeof title !== "string") continue;
        if (!byTitle.has(title)) byTitle.set(title, new Map());
        byTitle.get(title).set(canonical(schema), schema);
      }
    }
  };
  await walk(dir);
  return byTitle;
}

function pickRoot(byTitle, title) {
  const variants = byTitle.get(title);
  assert.ok(variants && variants.size > 0, `schema root ${title} not found in generated output`);
  assert.equal(
    variants.size,
    1,
    `schema root ${title} has conflicting definitions`,
  );
  return [...variants.values()][0];
}

function enumValues(node, root = node) {
  const values = new Set();
  const seen = new Set();
  const resolveRef = (ref) => {
    if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
    let current = root;
    for (const part of ref.slice(2).split("/")) {
      if (!current || typeof current !== "object") return null;
      current = current[part];
    }
    return current || null;
  };
  const visit = (current) => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current.enum)) {
      for (const value of current.enum) values.add(value);
    }
    if (current.$ref) visit(resolveRef(current.$ref));
    for (const key of ["oneOf", "anyOf", "allOf"]) {
      if (Array.isArray(current[key])) current[key].forEach(visit);
    }
    if (current.properties) Object.values(current.properties).forEach(visit);
    if (current.definitions) Object.values(current.definitions).forEach(visit);
    if (current.$defs) Object.values(current.$defs).forEach(visit);
    if (current.items) visit(current.items);
  };
  visit(node);
  return values;
}

async function testProtocolContract() {
  const out = await mkdtemp(path.join(tmpdir(), "dot-image-schema-"));
  try {
    const { code, stderr } = await run(
      SEED_CODEX,
      ["app-server", "generate-json-schema", "--experimental", "--out", out],
      { timeoutMs: 60000 },
    );
    assert.equal(code, 0, `generate-json-schema failed: ${stderr}`);
    const byTitle = await collectSchemas(out);

    const serverRequest = pickRoot(byTitle, "ServerRequest");
    const methods = new Set();
    for (const variant of serverRequest.oneOf || []) {
      for (const value of variant?.properties?.method?.enum || []) methods.add(value);
    }
    // The bridge consumes exactly these V2 server-request methods.
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
    ]) {
      assert.ok(methods.has(method), `ServerRequest must declare ${method}`);
    }

    // Approval decisions: the bridge only ever sends accept/decline.
    for (const title of [
      "CommandExecutionRequestApprovalResponse",
      "FileChangeRequestApprovalResponse",
    ]) {
      const schema = pickRoot(byTitle, title);
      assert.deepEqual(schema.required, ["decision"], `${title} must require decision`);
      const decisions = enumValues(schema.properties.decision, schema);
      assert.ok(decisions.has("accept"), `${title} must allow accept`);
      assert.ok(decisions.has("decline"), `${title} must allow decline`);
    }

    // Command approval request fields used by the fixtures.
    const cmdParams = pickRoot(byTitle, "CommandExecutionRequestApprovalParams");
    for (const field of ["itemId", "startedAtMs", "threadId", "turnId"]) {
      assert.ok(cmdParams.required.includes(field), `CommandExecutionRequestApprovalParams must require ${field}`);
    }
    const kinds = enumValues(cmdParams.definitions?.CommandExecutionApprovalKind);
    assert.ok(kinds.has("humanCommand"), "humanCommand kind must exist in the pinned schema");

    // ErrorNotification shape consumed by runTurn.
    const errorNotification = pickRoot(byTitle, "ErrorNotification");
    for (const field of ["error", "willRetry", "threadId", "turnId"]) {
      assert.ok(
        errorNotification.required.includes(field),
        `ErrorNotification must require ${field}`,
      );
    }

    // Terminal turn statuses from the TurnCompletedNotification schema.
    const turnCompleted = pickRoot(byTitle, "TurnCompletedNotification");
    const turnStatus =
      turnCompleted.definitions?.TurnStatus || turnCompleted.$defs?.TurnStatus;
    assert.ok(turnStatus, "TurnCompletedNotification must define TurnStatus");
    assert.deepEqual(
      [...enumValues(turnStatus)].sort(),
      ["completed", "failed", "inProgress", "interrupted"],
    );

    // thread/start reports the actual model and cwd.
    const threadStart = pickRoot(byTitle, "ThreadStartResponse");
    for (const field of ["thread", "model", "cwd"]) {
      assert.ok(
        threadStart.required.includes(field),
        `ThreadStartResponse must require ${field}`,
      );
    }
    console.log("ok: protocol contract matches the bundled CLI schemas");
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const tests = [
  ["codex --version", testVersion],
  ["app-server handshake", testAppServerHandshake],
  ["runtime seeding", testRuntimeSeeding],
  ["protocol contract", testProtocolContract],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}\n${error.stack || error}`);
  }
}
if (failed > 0) {
  console.error(`${failed} image test(s) failed`);
  process.exit(1);
}
console.log("all image tests passed");