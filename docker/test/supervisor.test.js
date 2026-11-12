// Supervisor tests: runtime seeding, auth seeding, entrypoint process
// supervision, remote-control worker and the Dots connector. Everything
// runs against temporary HOME/CODEX_HOME/seed directories and stub CLIs —
// never host auth, never real backends. Dots HTTP goes through a temporary
// local test server via DOT_CHATGPT_BASE_URL.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { childEnv } from "./support/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dockerDir = path.join(here, "..");
const ENTRYPOINT = path.join(dockerDir, "entrypoint.sh");
const REMOTE_CONTROL = path.join(dockerDir, "remote-control.sh");
const DOTS_EXECUTOR = path.join(dockerDir, "dots-executor.sh");

const DEADLINE_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeoutMs = DEADLINE_MS) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${label} not met within ${timeoutMs}ms`);
    }
    await sleep(25);
  }
}

// A stub codex executable: prints its version marker for --version and
// records every invocation into $STUB_LOG.
async function makeStubCodex(dir, { version = "codex-cli stub-A", mode = "ok" } = {}) {
  const bin = path.join(dir, "codex");
  const script = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${STUB_LOG:-/dev/null}"
case "$1" in
  --version)
    ${mode === "broken" ? "exit 1" : `printf '%s\\n' '${version}'`}
    ;;
  remote-control)
    ${mode === "hang" ? "sleep 300" : `printf '%s\\n' '{"event":"starting"}' '{"mode":"daemon","status":"connected","serverName":"stub","environmentId":"env_stub"}'`}
    ;;
  login)
    sleep 300
    ;;
  app-server)
    if [[ "$2" == "daemon" && "$3" == "stop" ]]; then exit 0; fi
    exit 0
    ;;
  exec-server)
    sleep 300
    ;;
  *)
    exit 0
    ;;
esac
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return bin;
}

// Build a seed home containing one standalone release.
async function makeSeedHome(root, name, { version, mode = "ok" } = {}) {
  const seedHome = path.join(root, name);
  const releaseDir = path.join(seedHome, "packages", "standalone", "releases", version);
  await mkdir(path.join(releaseDir, "bin"), { recursive: true });
  const bin = await makeStubCodex(path.join(releaseDir, "bin"), { version: `codex-cli ${version}`, mode });
  await symlink(path.join("releases", version), path.join(seedHome, "packages", "standalone", "current"));
  return { seedHome, bin };
}

async function makeTempRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "dot-sup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Run a bash snippet that sources a script and calls one function.
function runBashSnippet(t, snippet, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", snippet], {
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bash snippet timed out:\n${stdout}\n${stderr}`));
    }, 15000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// Start a long-lived script (entrypoint/worker/connector) with cleanup.
function startScript(t, script, env = {}, args = []) {
  const logs = { stdout: "", stderr: "" };
  const child = spawn("bash", [script, ...args], {
    env: childEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.stdout = (logs.stdout + chunk).slice(-65536);
  });
  child.stderr.on("data", (chunk) => {
    logs.stderr = (logs.stderr + chunk).slice(-65536);
  });
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
  });
  return { child, logs, exitPromise, get exited() { return exited; } };
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runtime seeding
// ---------------------------------------------------------------------------

describe("runtime seeding", () => {
  const seedSnippet = (seedHome, codexHome, extra = "") => `
    set -Eeuo pipefail
    export CODEX_HOME="${codexHome}"
    # CODEX_BIN intentionally unset: the entrypoint derives the default.
    ${extra}
    source "${ENTRYPOINT}"
    seed_runtime "${seedHome}" "${codexHome}"
    printf 'ACTIVE=%s\\n' "$(readlink -f "${codexHome}/packages/standalone/current")"
    printf 'VERSION=%s\\n' "$("${codexHome}/packages/standalone/current/bin/codex" --version)"
    printf 'RESOLVED=%s\\n' "$(command -v codex)"
  `;

  test("first start seeds the release and activates it", async (t) => {
    const root = await makeTempRoot(t);
    const { seedHome } = await makeSeedHome(root, "seed", { version: "1.0.0" });
    const codexHome = path.join(root, "data");
    const result = await runBashSnippet(t, seedSnippet(seedHome, codexHome), { STUB_LOG: path.join(root, "stub.log") });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ACTIVE=.*releases\/1\.0\.0/);
    assert.match(result.stdout, /VERSION=codex-cli 1\.0\.0/);
    assert.match(result.stdout, new RegExp(`RESOLVED=${codexHome}/packages/standalone/current/bin/codex`));
  });

  test("volume follows image upgrades and rollbacks; auth stays byte-identical", async (t) => {
    const root = await makeTempRoot(t);
    const seedA = await makeSeedHome(root, "seed-a", { version: "1.0.0" });
    const seedB = await makeSeedHome(root, "seed-b", { version: "2.0.0" });
    const codexHome = path.join(root, "data");
    const stubLog = path.join(root, "stub.log");
    const env = { STUB_LOG: stubLog };

    // Identity + auth bytes that must survive every upgrade.
    await mkdir(codexHome, { recursive: true });
    const authBytes = '{"tokens":{"access_token":"secret-token"}}\n';
    await writeFile(path.join(codexHome, "auth.json"), authBytes);
    await writeFile(path.join(codexHome, "installation_id"), "install-123\n");

    const first = await runBashSnippet(t, seedSnippet(seedA.seedHome, codexHome), env);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /VERSION=codex-cli 1\.0\.0/);

    const upgrade = await runBashSnippet(t, seedSnippet(seedB.seedHome, codexHome), env);
    assert.equal(upgrade.code, 0, upgrade.stderr);
    assert.match(upgrade.stdout, /VERSION=codex-cli 2\.0\.0/);

    const rollback = await runBashSnippet(t, seedSnippet(seedA.seedHome, codexHome), env);
    assert.equal(rollback.code, 0, rollback.stderr);
    assert.match(rollback.stdout, /VERSION=codex-cli 1\.0\.0/);

    assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), authBytes);
    assert.equal(await readFile(path.join(codexHome, "installation_id"), "utf8"), "install-123\n");
  });

  test("same version is reused without copying again", async (t) => {
    const root = await makeTempRoot(t);
    const { seedHome } = await makeSeedHome(root, "seed", { version: "1.0.0" });
    const codexHome = path.join(root, "data");
    const env = { STUB_LOG: path.join(root, "stub.log") };
    const first = await runBashSnippet(t, seedSnippet(seedHome, codexHome), env);
    assert.equal(first.code, 0, first.stderr);
    const marker = path.join(codexHome, "packages", "standalone", "releases", "1.0.0", "marker.txt");
    await writeFile(marker, "kept");
    const second = await runBashSnippet(t, seedSnippet(seedHome, codexHome), env);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(await readFile(marker, "utf8"), "kept", "release directory must be reused, not re-copied");
  });

  test("broken new seed leaves the current release intact", async (t) => {
    const root = await makeTempRoot(t);
    const good = await makeSeedHome(root, "seed-good", { version: "1.0.0" });
    const bad = await makeSeedHome(root, "seed-bad", { version: "2.0.0", mode: "broken" });
    const codexHome = path.join(root, "data");
    const env = { STUB_LOG: path.join(root, "stub.log") };
    const first = await runBashSnippet(t, seedSnippet(good.seedHome, codexHome), env);
    assert.equal(first.code, 0, first.stderr);
    const second = await runBashSnippet(t, seedSnippet(bad.seedHome, codexHome), env);
    assert.notEqual(second.code, 0, "broken seed must fail");
    assert.match(second.stdout + second.stderr, /no working codex executable/);
    const current = await readFile(path.join(codexHome, "packages", "standalone", "current", "bin", "codex"), "utf8");
    assert.ok(current.length > 0);
    const active = await runBashSnippet(t, `readlink -f "${codexHome}/packages/standalone/current"`);
    assert.match(active.stdout, /releases\/1\.0\.0/);
  });

  test("a real directory instead of the current symlink is rejected", async (t) => {
    const root = await makeTempRoot(t);
    const { seedHome } = await makeSeedHome(root, "seed", { version: "1.0.0" });
    const codexHome = path.join(root, "data");
    await mkdir(path.join(codexHome, "packages", "standalone", "current"), { recursive: true });
    await writeFile(path.join(codexHome, "packages", "standalone", "current", "precious"), "data");
    const result = await runBashSnippet(t, seedSnippet(seedHome, codexHome), { STUB_LOG: path.join(root, "stub.log") });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout + result.stderr, /not a symlink/);
    assert.equal(
      await readFile(path.join(codexHome, "packages", "standalone", "current", "precious"), "utf8"),
      "data",
    );
  });

  test("explicit CODEX_BIN is verified but never overwritten", async (t) => {
    const root = await makeTempRoot(t);
    const { seedHome } = await makeSeedHome(root, "seed", { version: "1.0.0" });
    const foreignDir = path.join(root, "foreign");
    await mkdir(foreignDir, { recursive: true });
    const foreign = await makeStubCodex(foreignDir, { version: "codex-cli foreign" });
    const codexHome = path.join(root, "data");
    const snippet = `
      set -Eeuo pipefail
      export CODEX_HOME="${codexHome}"
      export CODEX_BIN="${foreign}"
      source "${ENTRYPOINT}"
      seed_runtime "${seedHome}" "${codexHome}"
      printf 'VERSION=%s\\n' "$("${foreign}" --version)"
      printf 'RESOLVED=%s\\n' "$(command -v codex)"
    `;
    const result = await runBashSnippet(t, snippet, { STUB_LOG: path.join(root, "stub.log") });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /VERSION=codex-cli foreign/);
    assert.match(result.stdout, new RegExp(`RESOLVED=${foreign}`));
    // No seeded runtime was created.
    await assert.rejects(stat(path.join(codexHome, "packages")), /ENOENT/);
  });
});

// ---------------------------------------------------------------------------
// Auth seeding
// ---------------------------------------------------------------------------

describe("auth seeding", () => {
  const authSnippet = (codexHome, seed) => `
    set -Eeuo pipefail
    export CODEX_HOME="${codexHome}"
    export DOT_AUTH_SEED="${seed}"
    source "${ENTRYPOINT}"
    seed_auth
  `;

  test("non-empty seed is copied atomically with mode 0600", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const seed = path.join(root, "auth.json");
    await writeFile(seed, '{"OPENAI_API_KEY":"sk-test"}\n');
    const result = await runBashSnippet(t, authSnippet(codexHome, seed));
    assert.equal(result.code, 0, result.stderr);
    const copied = await readFile(path.join(codexHome, "auth.json"), "utf8");
    assert.equal(copied, '{"OPENAI_API_KEY":"sk-test"}\n');
    const mode = (await stat(path.join(codexHome, "auth.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test("existing non-empty auth is never replaced", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), "existing-auth");
    const seed = path.join(root, "auth.json");
    await writeFile(seed, "seed-auth");
    const result = await runBashSnippet(t, authSnippet(codexHome, seed));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(codexHome, "auth.json"), "utf8"), "existing-auth");
  });

  test("empty or missing seed allows device login (no error)", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const emptySeed = path.join(root, "empty.json");
    await writeFile(emptySeed, "");
    const empty = await runBashSnippet(t, authSnippet(codexHome, emptySeed));
    assert.equal(empty.code, 0, empty.stderr);
    const missing = await runBashSnippet(t, authSnippet(codexHome, path.join(root, "absent.json")));
    assert.equal(missing.code, 0, missing.stderr);
    await assert.rejects(stat(path.join(codexHome, "auth.json")), /ENOENT/);
  });

  test("directory mounts at seed or auth path are explicit errors", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const seedDir = path.join(root, "seed-dir");
    await mkdir(seedDir);
    const seedIsDir = await runBashSnippet(t, authSnippet(codexHome, seedDir));
    assert.notEqual(seedIsDir.code, 0);
    assert.match(seedIsDir.stdout + seedIsDir.stderr, /is a directory/);

    await mkdir(path.join(codexHome, "auth.json"));
    const authIsDir = await runBashSnippet(t, authSnippet(codexHome, path.join(root, "absent.json")));
    assert.notEqual(authIsDir.code, 0);
    assert.match(authIsDir.stdout + authIsDir.stderr, /is a directory/);
  });
});

// ---------------------------------------------------------------------------
// Remote-control worker
// ---------------------------------------------------------------------------

describe("remote-control worker", () => {
  test("records connected status with a fresh checkedAt", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    const bin = await makeStubCodex(binDir, { mode: "ok" });
    const worker = startScript(t, REMOTE_CONTROL, {
      CODEX_HOME: codexHome,
      CODEX_BIN: bin,
      STUB_LOG: path.join(root, "stub.log"),
      DOT_REMOTE_INTERVAL_SECONDS: "3600",
    });
    const statusFile = path.join(codexHome, "dot-remote-status.json");
    const status = await waitFor(() => readJsonIfExists(statusFile), "status file");
    assert.equal(status.status, "connected");
    assert.equal(status.environmentId, "env_stub");
    assert.ok(status.checkedAt, "checkedAt must be present");
    const age = Date.now() - Date.parse(status.checkedAt);
    assert.ok(age >= 0 && age < 10000, "checkedAt must be fresh");
    worker.child.kill("SIGTERM");
    await worker.exitPromise;
  });

  test("failing CLI overwrites connected with errored", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const statusFile = path.join(codexHome, "dot-remote-status.json");
    await writeFile(statusFile, JSON.stringify({ status: "connected", checkedAt: new Date().toISOString() }));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    // Stub that prints no status JSON at all.
    const bin = path.join(binDir, "codex");
    await writeFile(bin, "#!/usr/bin/env bash\necho 'noise only' >&2\nexit 1\n");
    await chmod(bin, 0o755);
    const worker = startScript(t, REMOTE_CONTROL, {
      CODEX_HOME: codexHome,
      CODEX_BIN: bin,
      DOT_REMOTE_INTERVAL_SECONDS: "3600",
    });
    const status = await waitFor(async () => {
      const data = await readJsonIfExists(statusFile);
      return data && data.status === "errored" ? data : null;
    }, "errored status");
    assert.equal(status.connected, undefined);
    worker.child.kill("SIGTERM");
    await worker.exitPromise;
  });

  test("hanging enrollment is bounded by the attempt timeout", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    const bin = await makeStubCodex(binDir, { mode: "hang" });
    const worker = startScript(t, REMOTE_CONTROL, {
      CODEX_HOME: codexHome,
      CODEX_BIN: bin,
      STUB_LOG: path.join(root, "stub.log"),
      DOT_REMOTE_INTERVAL_SECONDS: "3600",
      DOT_REMOTE_ATTEMPT_TIMEOUT: "1s",
    });
    const statusFile = path.join(codexHome, "dot-remote-status.json");
    const status = await waitFor(() => readJsonIfExists(statusFile), "bounded status", 8000);
    assert.equal(status.status, "errored");
    worker.child.kill("SIGTERM");
    await worker.exitPromise;
  });
});

// ---------------------------------------------------------------------------
// Entrypoint supervision
// ---------------------------------------------------------------------------

describe("entrypoint supervision", () => {
  // Minimal environment for a full entrypoint run with stub codex.
  async function setupEntrypoint(t, { seedVersion = "1.0.0", extraEnv = {} } = {}) {
    const root = await makeTempRoot(t);
    const { seedHome } = await makeSeedHome(root, "seed", { version: seedVersion });
    const codexHome = path.join(root, "data");
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await mkdir(codexHome, { recursive: true });
    await mkdir(home, { recursive: true });
    await mkdir(workspace, { recursive: true });
    // Auth present: no device login, ready quickly.
    await writeFile(path.join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-test"}\n');
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      CODEX_SEED_HOME: seedHome,
      DOT_WORKSPACE: workspace,
      DOT_API_PORT: "0",
      DOT_BIND: "127.0.0.1",
      DOT_DEVICE_LOGIN: "0",
      DOT_AUTH_SEED: path.join(root, "absent-seed.json"),
      STUB_LOG: path.join(root, "stub.log"),
      DOT_REMOTE_INTERVAL_SECONDS: "3600",
      ...extraEnv,
    };
    return { root, codexHome, home, workspace, env };
  }

  test("API starts even while enrollment hangs", async (t) => {
    const { root, codexHome, env } = await setupEntrypoint(t);
    // Replace the seeded codex with a hanging remote-control stub after seeding:
    // simplest is a seed whose remote-control hangs but --version works.
    const seedBin = path.join(env.CODEX_SEED_HOME, "packages", "standalone", "current", "bin", "codex");
    await writeFile(seedBin, `#!/usr/bin/env bash
case "$1" in
  --version) echo "codex-cli hang-seed" ;;
  remote-control) sleep 300 ;;
  *) exit 0 ;;
esac
`);
    await chmod(seedBin, 0o755);
    const entry = startScript(t, ENTRYPOINT, env);
    const baseUrl = await waitFor(() => {
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(entry.logs.stdout);
      return match ? `http://127.0.0.1:${match[1]}` : null;
    }, "API listening");
    const live = await fetch(`${baseUrl}/health`);
    assert.equal(live.status, 200);
    // Enrollment is still hanging: no connected status yet.
    const status = await readJsonIfExists(path.join(codexHome, "dot-remote-status.json"));
    assert.ok(!status || status.status !== "connected");
    entry.child.kill("SIGTERM");
    const { code } = await entry.exitPromise;
    assert.equal(code, 0);
  }, { timeout: 20000 });

  test("TERM shuts down all owned processes within the deadline", async (t) => {
    const { root, codexHome, env } = await setupEntrypoint(t, {
      extraEnv: { DOT_DEVICE_LOGIN: "1", DOT_DOTS_EXECUTOR: "0" },
    });
    // No auth: device login runs (stub sleeps). Remove the seeded auth.
    await rm(path.join(codexHome, "auth.json"));
    const entry = startScript(t, ENTRYPOINT, env);
    await waitFor(() => /device-code login/.test(entry.logs.stdout), "device login started");
    await waitFor(() => /api started/.test(entry.logs.stdout), "api started");
    const started = Date.now();
    entry.child.kill("SIGTERM");
    const { code } = await entry.exitPromise;
    const elapsed = Date.now() - started;
    assert.equal(code, 0);
    assert.ok(elapsed < 15000, `shutdown took ${elapsed}ms`);
    // No stub login process may survive.
    const stubLog = await readFile(env.STUB_LOG, "utf8").catch(() => "");
    assert.match(stubLog, /login --device-auth/);
  }, { timeout: 25000 });

  test("invalid seed mount fails with a clear error", async (t) => {
    const { root, env } = await setupEntrypoint(t);
    // Point CODEX_SEED_HOME at an empty directory.
    const emptySeed = path.join(root, "empty-seed");
    await mkdir(emptySeed, { recursive: true });
    const entry = startScript(t, ENTRYPOINT, { ...env, CODEX_SEED_HOME: emptySeed });
    const { code } = await entry.exitPromise;
    assert.notEqual(code, 0);
    assert.match(entry.logs.stdout + entry.logs.stderr, /no Codex seed release/);
  }, { timeout: 20000 });
});

// ---------------------------------------------------------------------------
// Dots connector against a local test server
// ---------------------------------------------------------------------------

describe("dots connector", () => {
  async function startBackend(t) {
    const requests = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/flora/cca/executor") {
          res.end(JSON.stringify({ executor_id: "env_test_1" }));
        } else if (req.url === "/tbo/primary") {
          res.end(JSON.stringify({ selection: { thread_id: "thread_1" } }));
        } else if (req.url === "/tbo/by-thread/thread_1") {
          res.end(JSON.stringify({ id: "tbo_1" }));
        } else if (req.url.startsWith("/tbo/tbo_1/computers?")) {
          res.end(JSON.stringify({ computers: [] }));
        } else if (req.url.includes("/connect-and-replace")) {
          res.statusCode = 200;
          res.end("{}");
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { baseUrl: `http://127.0.0.1:${port}`, requests };
  }

  test("registers, attaches and starts exec-server; TERM stops everything", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "test-token", account_id: "acc" } }));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    const bin = await makeStubCodex(binDir);
    const backend = await startBackend(t);
    const connector = startScript(t, DOTS_EXECUTOR, {
      CODEX_HOME: codexHome,
      CODEX_BIN: bin,
      DOT_CHATGPT_BASE_URL: backend.baseUrl,
      DOT_DOTS_NAME: "test-dot",
      DOT_DOTS_POLL_SECONDS: "3600",
      STUB_LOG: path.join(root, "stub.log"),
      DOT_WORKSPACE: root,
    });
    await waitFor(() => /exec-server pid=/.test(connector.logs.stderr), "exec-server started", 10000);
    const envId = await readFile(path.join(codexHome, ".dots-executor-environment-id"), "utf8");
    assert.equal(envId.trim(), "env_test_1");
    assert.ok(backend.requests.some((r) => r.url.includes("/connect-and-replace")), "attach was called");
    const stubLog = await readFile(path.join(root, "stub.log"), "utf8");
    assert.match(stubLog, /exec-server/);
    const started = Date.now();
    connector.child.kill("SIGTERM");
    const { code } = await connector.exitPromise;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 8000, "connector shutdown must be bounded");
  }, { timeout: 25000 });

  test("TERM during registration retries stops promptly", async (t) => {
    const root = await makeTempRoot(t);
    const codexHome = path.join(root, "data");
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "test-token" } }));
    const binDir = path.join(root, "bin");
    await mkdir(binDir);
    const bin = await makeStubCodex(binDir);
    // Backend that always fails registration.
    const server = createServer((req, res) => {
      res.statusCode = 500;
      res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    const connector = startScript(t, DOTS_EXECUTOR, {
      CODEX_HOME: codexHome,
      CODEX_BIN: bin,
      DOT_CHATGPT_BASE_URL: `http://127.0.0.1:${port}`,
      DOT_DOTS_NAME: "test-dot",
      STUB_LOG: path.join(root, "stub.log"),
      DOT_WORKSPACE: root,
    });
    await waitFor(() => /registration attempt 1 failed/.test(connector.logs.stderr), "retry phase");
    const started = Date.now();
    connector.child.kill("SIGTERM");
    const { code } = await connector.exitPromise;
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000, "retry sleep must be interruptible");
  }, { timeout: 20000 });
});