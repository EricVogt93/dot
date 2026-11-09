#!/usr/bin/env bash
# Dot container supervisor: seed the Codex runtime, authenticate, enroll this
# container as a remote-control device, and keep the HTTP API alive.
set -Eeuo pipefail

export CODEX_HOME="${CODEX_HOME:-/data/codex}"
export HOME="${HOME:-/data}"
export DOT_WORKSPACE="${DOT_WORKSPACE:-/workspace}"
export DOT_API_PORT="${DOT_API_PORT:-8787}"
export DOT_AUTH_SEED="${DOT_AUTH_SEED:-/seed/auth.json}"
export DOT_DEVICE_LOGIN="${DOT_DEVICE_LOGIN:-1}"
export PATH="/opt/codex-seed/bin:${PATH}"

CODEX_BIN="${CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/bin/codex}"
export CODEX_BIN

log() { printf '%s [dot] %s\n' "$(date -Is)" "$*"; }

mkdir -p "${CODEX_HOME}" "${DOT_WORKSPACE}" "${HOME}/.cache" "${HOME}/.config"

# ---------------------------------------------------------------------------
# 1. Seed the standalone Codex package into the persistent volume.
# ---------------------------------------------------------------------------
if [[ ! -e "${CODEX_HOME}/packages/standalone/current" ]]; then
  log "seeding Codex runtime into ${CODEX_HOME}/packages"
  mkdir -p "${CODEX_HOME}/packages"
  cp -a /opt/codex-seed/packages/standalone "${CODEX_HOME}/packages/"
  release="$(basename "$(readlink -f /opt/codex-seed/packages/standalone/current)")"
  ln -sfn "${CODEX_HOME}/packages/standalone/releases/${release}" \
    "${CODEX_HOME}/packages/standalone/current"
fi

if [[ ! -x "${CODEX_BIN}" ]]; then
  log "FATAL: Codex binary missing at ${CODEX_BIN}"
  exit 1
fi
log "codex: $("${CODEX_BIN}" --version 2>/dev/null || echo unknown)"

# ---------------------------------------------------------------------------
# 2. Default runtime policy and git safety for the mounted workspace.
# ---------------------------------------------------------------------------
if [[ ! -f "${CODEX_HOME}/config.toml" ]]; then
  cat >"${CODEX_HOME}/config.toml" <<'EOF'
# Dot container defaults: the container boundary is the sandbox.
approval_policy = "never"
sandbox_mode = "danger-full-access"
EOF
fi

git config --global --add safe.directory "${DOT_WORKSPACE}" 2>/dev/null || true
if [[ "${DOT_WORKSPACE}" != "/workspace" ]]; then
  git config --global --add safe.directory /workspace 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 3. Authentication: seed from the host, otherwise run device-code login.
# ---------------------------------------------------------------------------
if [[ ! -f "${CODEX_HOME}/auth.json" && -f "${DOT_AUTH_SEED}" ]]; then
  log "copying auth seed from ${DOT_AUTH_SEED}"
  cp "${DOT_AUTH_SEED}" "${CODEX_HOME}/auth.json"
  chmod 600 "${CODEX_HOME}/auth.json"
fi

if [[ ! -f "${CODEX_HOME}/auth.json" && "${DOT_DEVICE_LOGIN}" != "0" ]]; then
  log "no auth.json found; starting ChatGPT device-code login in background"
  (
    "${CODEX_BIN}" login --device-auth 2>&1 | tee -a "${CODEX_HOME}/login.log"
  ) &
  log "device login output is streamed to container logs and ${CODEX_HOME}/login.log"
fi

# ---------------------------------------------------------------------------
# 4. Remote control: enroll this container as a connectable ChatGPT device.
# ---------------------------------------------------------------------------

record_remote_status() {
  local final="$1"
  printf '%s\n' "${final}" >"${CODEX_HOME}/dot-remote-status.json"
  log "remote control: ${final}"
}

start_remote_control() {
  local output final attempt
  final=''
  for attempt in 1 2 3 4; do
    output="$("${CODEX_BIN}" remote-control start --json 2>&1)" || true
    final="$(printf '%s\n' "${output}" | jq -c 'select(.status != null)' 2>/dev/null | tail -n 1 || true)"
    if [[ -n "${final}" ]] && printf '%s' "${final}" | jq -e '.status == "connected"' >/dev/null 2>&1; then
      record_remote_status "${final}"
      return 0
    fi
    sleep 2
  done
  if [[ -z "${final}" ]]; then
    final='{"status":"errored","serverName":null,"environmentId":null}'
  fi
  record_remote_status "${final}"
}

start_remote_control

# ---------------------------------------------------------------------------
# 5. HTTP API supervisor.
# ---------------------------------------------------------------------------
API_PID=""
start_api() {
  node /app/server.js &
  API_PID=$!
  log "api started pid=${API_PID}"
}

start_api

shutdown() {
  log "shutting down"
  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    kill "${API_PID}" 2>/dev/null || true
  fi
  "${CODEX_BIN}" app-server daemon stop >/dev/null 2>&1 || true
  exit 0
}
trap shutdown SIGTERM SIGINT

while true; do
  sleep 30 || true
  if [[ -z "${API_PID}" ]] || ! kill -0 "${API_PID}" 2>/dev/null; then
    log "api process is not running; restarting"
    start_api
  fi

  daemon_ok=0
  if "${CODEX_BIN}" app-server daemon version >/dev/null 2>&1; then
    daemon_ok=1
  fi
  status="$(jq -r '.status // "unknown"' "${CODEX_HOME}/dot-remote-status.json" 2>/dev/null || echo unknown)"
  if [[ "${daemon_ok}" -eq 0 || "${status}" != "connected" ]]; then
    log "remote control not connected (daemon_ok=${daemon_ok}, status=${status}); retrying"
    start_remote_control
  fi
done
