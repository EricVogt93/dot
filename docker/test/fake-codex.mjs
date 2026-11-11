#!/usr/bin/env node
// Minimal stand-in for the `codex` CLI used by the integration tests. It
// implements only what server.js calls: `--version`, `remote-control pair`,
// and a newline-delimited JSON-RPC `app-server --listen stdio://`.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log("codex-cli 0.0.0-fake");
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

let threads = 0;
let turns = 0;
let serverReqId = 1000;
const pendingServerReqs = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function requestFromClient(method, params) {
  const id = serverReqId++;
  return new Promise((resolve) => {
    pendingServerReqs.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;

  if (id !== undefined && method === undefined) {
    const resolve = pendingServerReqs.get(id);
    if (resolve) {
      pendingServerReqs.delete(id);
      resolve(message);
    }
    return;
  }

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { userAgent: "fake-codex/0.0.0" } });
  } else if (method === "thread/start") {
    await new Promise((resolve) => setTimeout(resolve, 15));
    threads += 1;
    send({ jsonrpc: "2.0", id, result: { thread: { id: `thr_${threads}` } } });
  } else if (method === "turn/start") {
    turns += 1;
    const turnId = `turn_${turns}`;
    const text = params.input.map((part) => part.text).join(" ");
    send({ jsonrpc: "2.0", id, result: { turn: { id: turnId } } });

    if (text === "crash-mid-turn") {
      setTimeout(() => process.exit(1), 20);
      return;
    }

    if (text === "check-approvals") {
      const execReply = await requestFromClient("execCommandApproval", {});
      const permReply = await requestFromClient("permissionsRequestApproval", {});
      const summary = `exec=${execReply.result?.decision} permErr=${permReply.error?.code}`;
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: params.threadId, turnId, delta: summary },
      });
      send({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: { threadId: params.threadId, turn: { id: turnId, items: [] } },
      });
      return;
    }

    for (const delta of ["echo: ", text]) {
      send({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: { threadId: params.threadId, turnId, delta },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: params.threadId, turn: { id: turnId, items: [] } },
    });
  } else if (method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined && method !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "not found" } });
  }
});
