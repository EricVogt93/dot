# How dot talks to Codex

dot only drives the public [Codex CLI](https://github.com/openai/codex)
(`codex`, Apache-2.0). Everything below is observable CLI behavior; dot does
not ship, patch, or bundle any part of the ChatGPT desktop application.

## Remote control (connectable device)

- `codex remote-control start --json` starts a managed app-server daemon,
  enrolls the host with the logged-in ChatGPT account, and prints event lines
  followed by a final JSON object, e.g.
  `{"mode":"daemon","status":"connected","serverName":"<hostname>","environmentId":"env_e_…"}`.
- The device name is the host name (container hostname).
- Each enrollment is tied to the `installation_id` stored in `CODEX_HOME`.
  Two instances sharing one `CODEX_HOME` collide: the second stays
  `connecting`/`errored`. Use one persistent `/data` volume per container.
- `codex remote-control pair --json` returns a long `pairingCode` and a short
  `manualPairingCode` (`XXXX-XXXX`) bound to the host's `environmentId`.
  Codes expire after a few minutes.
- `GET https://chatgpt.com/backend-api/wham/remote/control/environments`
  (with the account's access token) lists enrolled hosts. dot's
  `/v1/remote/environments` proxies this call and marks its own entry as
  `self`. This endpoint is not a documented public API and may change.

Enrollment authenticates with the ChatGPT OAuth tokens in `auth.json`.

## App-server protocol

`codex app-server --listen stdio://` speaks newline-delimited JSON-RPC on
stdin/stdout. dot uses this subset:

| Direction | Message | Purpose |
|---|---|---|
| → | `initialize` / `initialized` | Handshake with `clientInfo` |
| → | `thread/start` | New thread (`cwd`, `sandbox`, `approvalPolicy`, `model`, `developerInstructions`); the response's `model`/`cwd` are the actual configuration |
| → | `turn/start` | Send user input to a thread |
| → | `turn/interrupt` | Cancel the running turn |
| ← | `item/agentMessage/delta` | Streaming assistant text |
| ← | `turn/completed` | Terminal turn state: `status` is `completed`, `interrupted` or `failed` (with nullable structured `error`); text may arrive in `items` |
| ← | `error` | Turn error notification (`error`, `willRetry`, `threadId`, `turnId`); `willRetry: true` means Codex retries internally and the turn stays open |
| ← | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | V2 approvals: answered `{decision: "accept"}` only with `approval_policy = "never"` and `sandbox = "danger-full-access"`, otherwise `{decision: "decline"}`; `kind: "humanCommand"` is always declined |
| ← | `item/permissions/requestApproval` | Rejected with JSON-RPC `-32601`: dot never widens the sandbox |
| ← | `item/tool/requestUserInput` | Answered with `{answers: {}}` |

The authoritative schema comes from the Codex CLI itself
(`codex app-server generate-json-schema --experimental`); the image smoke
test checks the consumed methods, decisions, statuses and required fields
against the schemas of the exact bundled release.

## Authentication

- `CODEX_HOME/auth.json` holds ChatGPT tokens or an API key. The entrypoint
  copies a read-only seed into the data volume once, so token refreshes never
  modify the host file.
- Without a seed, `codex login --device-auth` prints a URL and one-time code in
  the container logs.
