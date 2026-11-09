> Paths under `work/` refer to the local extraction of the shipped app used during analysis; they are not part of this repository.

# Dot / Codex remote-control reverse-engineering findings

Target: ChatGPT/Codex desktop app `26.1103.60933`
(`data/chatgpt-26.1103.60933/usr/lib/chatgpt`)

Scope: what the shipped app does to (a) enroll a machine as a connectable
source in the ChatGPT GUI and (b) pair a controller to that machine. Runtime
observations from the same build's bundled `codex` CLI are included and marked.

Legend: **OBSERVED** = direct static/dynamic evidence; **INFERRED** = reasoned
from evidence; **UNKNOWN** = not established.

## Evidence table

| Evidence ID | Observation | Confidence |
|---|---|---|
| `ev_07c3936a6a66052a66f714507627f666620725e2fe684d8f1ab2d46268ce7c6d` | Hopper procedure inventory for `native/remote-control-device-key.node` (ELF x86-64, SHA-256 `517ddc38…d8ff`); exports `CreateDeviceKeyBinding` @0x8fa0, `GetDeviceKeyPublicBinding` @0x9590, `SignDeviceKeyBinding` @0x9830; core `CreateDeviceKey` @0xc080, `GetDeviceKeyPublic` @0xee90, `DeleteDeviceKey` @0xf540, `SignDeviceKeyDerBase64` @0xf6b0, `SignAndVerify` @0xdba0, `Tpm4Open` @0xcf70, `Tpm4Load` @0xd710 | OBSERVED |
| `ev_a3aeea004ef39edb4f7da42266afc0f6f1f3731a21963332924fbfae6408011e` | Hopper string inventory. Key strings: `signDeviceKey` @0x52e9, `createDeviceKey` @0x5581, `getDeviceKeyPublic` @0x5411, `deleteDeviceKey` @0x5d21, `keyId` @0x5ba0, `protectionClass` @0x537e, `publicKeySpkiDerBase64` @0x54c9, `signatureDerBase64` @0x5e29, `ecdsa_p256_sha256` @0x5ea0, `prime256v1` @0x5aa8, `hardware_tpm` @0x53e0, `hardware_only` @0x5ba9, `allow_os_protected_nonextractable` @0x51b6, `/dev/tpmrm0` @0x56d2, `dk_htp_linux_v1_` @0x5f10, `OpenAI Codex Linux device key check v1` @0x6040 | OBSERVED |
| `ev_a9fba236d9a83ccbb95deb367a59aff4b5ed80bd860754f185f537f39a71099b` (parent `ev_508939…e59e`) | Dossier for `SignDeviceKeyBinding` @0x9830: 47 basic blocks, 14 callees; calls `SignDeviceKeyDerBase64`; referenced strings include `signDeviceKey`, `signatureDerBase64`, `keyId` | OBSERVED |
| `ev_fd92cc8543dfbe7fd0da63175e3ecc6e752b794ee5ddd08a20c628463a3693e9` (parent `ev_a3a500…02d2`) | Dossier for `SignDeviceKeyDerBase64` @0xf6b0: 5 blocks, 15 callees; hashes/signs through TPM path and returns base64 DER signature | OBSERVED |
| `work/app_asar/.vite/build/early-bootstrap-815-e030c49be4b9c405.js` | Electron main contains `remoteControlDeviceKeyClient`; `signDeviceKey` is called with `{type:"remoteControlClientEnrollment", nonce, audience:"remote_control_client_enrollment", challengeId, targetOrigin, targetPath, accountUserId, ...}` and `{type:"remoteControlClientConnection", nonce, audience:"remote_control_client_websocket", ...}` | OBSERVED |
| `work/app_asar/.vite/build/early-bootstrap-815-e030c49be4b9c405.js` | Catalog code treats `source:"remote-control"` entries as hosts with `envId`, `online`, `clientType`, `os`, `arch`, `appServerVersion`, `installationId`; `connections/remoteControl/add` accepts `pairingCode`, `projectPath`, `activate` | OBSERVED |
| `work/app_asar/webview/assets/async/182735.5b42af8792.js` | Client HTTP paths: `POST /wham/remote/control/client/pair`, `GET /wham/remote/control/clients`, `DELETE /wham/remote/control/clients/{client_id}`, `GET /wham/remote/control/mfa_requirement` | OBSERVED |
| `strings` on `resources/codex` | Server paths: `/wham/remote/control/server/enroll`, `/wham/remote/control/server/refresh`, `/wham/remote/control/server/pair`, `/wham/remote/control/server/pair/status`, `/wham/remote/control/environments`; transport module paths `app-server-transport/src/transport/remote_control/{auth,enroll,server_api,websocket,controller,persistence,host_device,clients,client_tracker,segment}.rs` | OBSERVED |
| Runtime, bundled `codex` 0.167.0 | `codex remote-control start --json` returned `{"mode":"daemon","status":"connected","serverName":"archlinux","environmentId":"env_e_…","timedOut":false}`; `remote_control_enrollments` row `wss://chatgpt.com/backend-api/wham/remote/control/server|<account>|…|<server_id>|<env_id>|<hostname>` | OBSERVED |
| Runtime, ChatGPT backend | `GET /backend-api/wham/remote/control/environments` returned this machine `online:true` with `client_type:"CODEX_CLI"`, `originator:"codex_cli_rs"`, matching `installation_id` | OBSERVED |
| Runtime, bundled `codex` 0.167.0 | `codex remote-control pair --json` returned `{"pairingCode":"<long>","manualPairingCode":"U9DM-Q5UM","environmentId":"env_e_…","expiresAt":…}` | OBSERVED |

## Device-key native module

`native/remote-control-device-key.node` is a N-API module. Its exported
surface is exactly `createDeviceKey`, `getDeviceKeyPublic`, `signDeviceKey`,
`deleteDeviceKey`. It is **client-side** material: the Electron app uses it
when a controller (desktop/phone) enrolls against a host and when it opens the
controller websocket.

- **OBSERVED** The module is Linux TPM 2.0 backed: it opens `/dev/tpmrm0`,
  creates a storage primary, creates/loads a P-256 (`prime256v1`) ECDSA key,
  signs with `ecdsa_p256_sha256`, verifies the signature through OpenSSL, and
  returns `signatureDerBase64`.
- **OBSERVED** Key material is persisted as a key record under `device-keys`
  with a `dk_htp_linux_v1_` id prefix; the public half is exported as
  `publicKeySpkiDerBase64` (SPKI DER, base64).
- **OBSERVED** Protection policy strings are `hardware_tpm`, `hardware_only`,
  and `allow_os_protected_nonextractable`; errors include
  `remote_control_device_key_tpm_unavailable` and
  `TPM key does not satisfy device key protection requirements`.
- **OBSERVED** The check phrase `OpenAI Codex Linux device key check v1` and
  `dk_htp_linux_v1_` identify a Linux hardware-protected device key scheme.
- **INFERRED** `signDeviceKey(keyId, payload)` hashes the payload (SHA-256) and
  produces a DER-encoded ECDSA P-256 signature, which the JS layer sends as
  `signatureDerBase64` alongside the nonce-bearing challenge object.
- **INFERRED** The TPM requirement is a controller/device attestation
  mechanism: it lets the server verify that a pairing request came from a
  hardware-backed device key. It is not required for the *host* side
  enrollment used by the Docker deliverable.
- **UNKNOWN** Exact TPM session policy/authorization derivation and TPM
  handle layout; Hopper exposes code but no original source.
- **UNKNOWN** Whether the macOS/Windows builds use Secure Enclave/CNG instead
  of TPM; only the Linux module was analyzed.

## Host enrollment and pairing protocol

### Host side (what the container does)

1. **OBSERVED** The host CLI runs an app-server with `--remote-control` and a
   managed daemon; the transport connects a websocket to
   `wss://chatgpt.com/backend-api/wham/remote/control/server`.
2. **OBSERVED** On first connect the daemon enrolls using the stored ChatGPT
   credentials and persists `server_id`, `environment_id`, `server_name`
   (hostname), and `websocket_url` in `remote_control_enrollments`.
3. **OBSERVED** The backend lists the host under
   `/wham/remote/control/environments` with `online`, `busy`, `os`, `arch`,
   `app_server_version`, `installation_id`, `client_type`, `originator`,
   `last_seen_at`. This is the data the ChatGPT GUI renders as a connectable
   source/device.
4. **OBSERVED** `remote-control start --json` emits `status:"connected"` only
   after the websocket handshake; a fresh `installation_id` is required —
   reusing an `installation_id` that is already online yields
   `status:"connecting"`/`errored` and the backend keeps the original
   environment.
5. **OBSERVED** `remote-control pair --json` returns both a long `pairingCode`
   and a short `manualPairingCode` (`XXXX-XXXX`) bound to the host's
   `environmentId`, expiring after ~10 minutes.

### Controller side (ChatGPT GUI / phone pairing)

1. **OBSERVED** The controller requests
   `POST /wham/remote/control/client/pair` with a pairing code and receives a
   `device_key_challenge` (`nonce`, `audience`, `sessionId`,
   `targetOrigin`, `targetPath`, `accountUserId`, `clientId`).
2. **OBSERVED** The controller signs that challenge with
   `remoteControlDeviceKeyClient.signDeviceKey(keyId, {type:"remoteControlClientEnrollment", …})`
   and submits the `signatureDerBase64` with its SPKI public key.
3. **OBSERVED** After enrollment the controller opens a websocket and signs
   `remoteControlClientConnection` challenges with
   `audience:"remote_control_client_websocket"`; the host transport validates
   these (`app-server-transport/src/transport/remote_control/auth.rs`,
   `client_tracker.rs`, `controller.rs`).
4. **OBSERVED** Paired controllers are listed by
   `GET /wham/remote/control/clients` with `display_name`, `device_type`,
   `platform`, `last_seen_*`; `DELETE /wham/remote/control/clients/{client_id}`
   revokes one.
5. **INFERRED** The GUI's "connectable source" list is the environment list
   above; pairing/authorizing a controller is a separate step from the host
   being online.

## What this proves for the Docker deliverable

- The runtime we need is the bundled `codex` CLI's **server-side**
  `remote-control` transport, not the Electron UI and not the TPM device-key
  module. Running `codex remote-control start` with a seeded ChatGPT
  `auth.json` and a fresh `installation_id` enrolls the container and makes it
  appear online in `/wham/remote/control/environments` — verified on this
  machine.
- A container hostname (`--hostname`) determines the visible `server_name` /
  environment display name.
- Device login can seed `auth.json` without a host browser: `codex login
  --device-auth` prints a URL and one-time code.
- The controller-side TPM module only matters if the container itself is used
  as a controller of another machine; it is not needed to be a connectable
  source. On Linux without `/dev/tpmrm0`, the host enrollment path still works
  because it authenticates with ChatGPT OAuth tokens, not TPM.

## Unknowns / limitations

- No GUI screenshot of the ChatGPT device list was captured; the backend
  environment record is the evidence that the GUI reads.
- Remote-control transport internals (segmenting, heartbeats, desired-state
  reconciliation) were not fully decompiled; only the CLI behavior and
  string/table evidence are asserted.
- The Hopper analysis of the 320 MB `resources/codex` binary was not needed for
  the deliverable; the same protocol is exposed by the generated app-server
  schema and the CLI. That binary's remote-control code paths remain
  represented only by string/module-path evidence.
- Device-key TPM semantics are inferred from strings/imports and call graph;
  the exact TPM command sequences were not reconstructed instruction by
  instruction.
