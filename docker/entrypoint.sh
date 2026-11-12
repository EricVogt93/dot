#!/usr/bin/env bash
# Dot container supervisor: seed the Codex runtime, authenticate, enroll this
# container as a remote-control device, and keep the HTTP API alive.
#
# The entry code lives in main() and only runs when this file is executed
# directly, so tests can source it and exercise individual functions.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export CODEX_HOME="${CODEX_HOME:-/data/codex}"
export HOME="${HOME:-/data}"
export DOT_WORKSPACE="${DOT_WORKSPACE:-/workspace}"
export DOT_API_PORT="${DOT_API_PORT:-8787}"
export DOT_AUTH_SEED="${DOT_AUTH_SEED:-/seed/auth.json}"
export DOT_DEVICE_LOGIN="${DOT_DEVICE_LOGIN:-1}"
export DOT_MAX_LOG_BYTES="${DOT_MAX_LOG_BYTES:-10485760}"
export CODEX_SEED_HOME="${CODEX_SEED_HOME:-/opt/codex-seed}"

# Remember an explicit override before applying the default: an explicit
# CODEX_BIN must never be overwritten by runtime seeding.
CODEX_BIN_OVERRIDE="${CODEX_BIN:-}"
CODEX_BIN="${CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/bin/codex}"
export CODEX_BIN

log() { printf '%s [dot] %s\n' "$(date -Is)" "$*"; }

rotate_log() {
  local file="$1" size
  [[ -f "${file}" ]] || return 0
  size="$(wc -c <"${file}" 2>/dev/null || echo 0)"
  if [[ "${size}" -gt "${DOT_MAX_LOG_BYTES}" ]]; then
    cp -f "${file}" "${file}.1" 2>/dev/null || true
    : >"${file}"
  fi
}

# ---------------------------------------------------------------------------
# Runtime seeding: follow the image release on every start (including
# downgrades/rollbacks), atomically, without touching auth or identity data.
# ---------------------------------------------------------------------------
seed_runtime() {
  local seed_home="$1" codex_home="$2"
  local base="${codex_home}/packages/standalone"

  if [[ -n "${CODEX_BIN_OVERRIDE}" ]]; then
    # Foreign runtime: only verify the executable, never overwrite it.
    if [[ ! -x "${CODEX_BIN}" ]]; then
      log "FATAL: Codex binary missing at ${CODEX_BIN}"
      return 1
    fi
    export PATH="$(dirname "${CODEX_BIN}"):${PATH}"
    return 0
  fi

  local seed_current="${seed_home}/packages/standalone/current"
  if [[ ! -e "${seed_current}" ]]; then
    log "FATAL: no Codex seed release at ${seed_current}"
    return 1
  fi
  local release
  release="$(basename "$(readlink -f "${seed_current}")")"
  local target="${base}/releases/${release}"
  mkdir -p "${base}/releases"

  if [[ -d "${target}" ]]; then
    # Reuse an existing release only when its executable actually works.
    if [[ ! -x "${target}/bin/codex" ]] || ! "${target}/bin/codex" --version >/dev/null 2>&1; then
      log "FATAL: existing release ${target} is broken; refusing to overwrite unknown data"
      return 1
    fi
  else
    # Copy into a temporary directory on the same filesystem, verify, then
    # move atomically into place.
    local tmp
    tmp="$(mktemp -d "${base}/releases/.seed-XXXXXX")"
    if ! cp -a "${seed_home}/packages/standalone/releases/${release}/." "${tmp}/"; then
      rm -rf "${tmp}"
      log "FATAL: copying seed release ${release} failed"
      return 1
    fi
    if [[ ! -x "${tmp}/bin/codex" ]] || ! "${tmp}/bin/codex" --version >/dev/null 2>&1; then
      rm -rf "${tmp}"
      log "FATAL: seed release ${release} has no working codex executable"
      return 1
    fi
    mv -T "${tmp}" "${target}"
  fi

  # A real directory where the current symlink belongs is unknown data.
  if [[ -e "${base}/current" && ! -L "${base}/current" ]]; then
    log "FATAL: ${base}/current is not a symlink; refusing to touch unknown data"
    return 1
  fi
  local tmp_link="${base}/.current.tmp.$$"
  ln -sfn "releases/${release}" "${tmp_link}"
  mv -Tf "${tmp_link}" "${base}/current"

  # The active runtime must win over any image-seed PATH entry.
  export PATH="$(dirname "${CODEX_BIN}"):${PATH}"
  log "codex runtime: ${release} -> ${CODEX_BIN}"
}

# ---------------------------------------------------------------------------
# Auth seeding: files only, never replace non-empty auth, explicit errors for
# directory mounts.
# ---------------------------------------------------------------------------
seed_auth() {
  local auth="${CODEX_HOME}/auth.json" seed="${DOT_AUTH_SEED}"
  if [[ -d "${auth}" ]]; then
    log "FATAL: ${auth} is a directory; mount a file or remove it"
    return 1
  fi
  if [[ -s "${auth}" ]]; then
    return 0
  fi
  if [[ -d "${seed}" ]]; then
    log "FATAL: auth seed ${seed} is a directory; mount an auth.json file (an empty file enables device login)"
    return 1
  fi
  if [[ -s "${seed}" ]]; then
    log "copying auth seed from ${seed}"
    cp "${seed}" "${auth}.tmp"
    chmod 600 "${auth}.tmp"
    mv -f "${auth}.tmp" "${auth}"
  fi
  # Missing/empty seed: device login may run below.
}

write_default_config() {
  if [[ ! -f "${CODEX_HOME}/config.toml" ]]; then
    cat >"${CODEX_HOME}/config.toml" <<'EOF'
# Dot container defaults: the container boundary is the sandbox.
approval_policy = "never"
sandbox_mode = "danger-full-access"
EOF
  fi
}

# ---------------------------------------------------------------------------
# Owned child processes (each in its own process group via setsid).
# ---------------------------------------------------------------------------
API_PID=""
REMOTE_PID=""
DOTS_EXECUTOR_PID=""
LOGIN_PID=""
SLEEP_PID=""
SHUTTING_DOWN=0
OWNED_PIDS=()

own_pid() {
  OWNED_PIDS+=("$1")
}

start_api() {
  setsid node "${SCRIPT_DIR}/server.js" &
  API_PID=$!
  own_pid "${API_PID}"
  log "api started pid=${API_PID}"
}

start_remote_worker() {
  setsid "${SCRIPT_DIR}/remote-control.sh" >>"${CODEX_HOME}/remote-control.log" 2>&1 &
  REMOTE_PID=$!
  own_pid "${REMOTE_PID}"
  log "remote-control worker pid=${REMOTE_PID}"
}

start_dots_executor() {
  if [[ "${DOT_DOTS_EXECUTOR:-0}" != "1" ]]; then
    return 0
  fi
  if [[ -n "${DOTS_EXECUTOR_PID}" ]] && kill -0 "${DOTS_EXECUTOR_PID}" 2>/dev/null; then
    return 0
  fi
  log "starting Dots local executor connector (EXPERIMENTAL, undocumented ChatGPT endpoints)"
  setsid "${SCRIPT_DIR}/dots-executor.sh" >>"${CODEX_HOME}/dots-executor.log" 2>&1 &
  DOTS_EXECUTOR_PID=$!
  own_pid "${DOTS_EXECUTOR_PID}"
  log "dots executor pid=${DOTS_EXECUTOR_PID}"
}

start_device_login() {
  if [[ -s "${CODEX_HOME}/auth.json" || "${DOT_DEVICE_LOGIN}" == "0" ]]; then
    return 0
  fi
  log "no auth.json found; starting ChatGPT device-code login in background"
  : >"${CODEX_HOME}/login.log"
  setsid bash -c '"$1" login --device-auth 2>&1 | tee -a "$2"' _ "${CODEX_BIN}" "${CODEX_HOME}/login.log" &
  LOGIN_PID=$!
  own_pid "${LOGIN_PID}"
  log "device login output is streamed to container logs and ${CODEX_HOME}/login.log"
}

# ---------------------------------------------------------------------------
# Bounded, idempotent shutdown.
# ---------------------------------------------------------------------------
terminate_owned() {
  local pid
  for pid in "${OWNED_PIDS[@]}"; do
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  done
  if [[ -n "${SLEEP_PID}" ]]; then
    kill "${SLEEP_PID}" 2>/dev/null || true
  fi
  local deadline=$((SECONDS + 5)) alive
  while (( SECONDS < deadline )); do
    alive=0
    for pid in "${OWNED_PIDS[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        alive=1
        break
      fi
    done
    (( alive == 0 )) && break
    sleep 0.2
  done
  for pid in "${OWNED_PIDS[@]}"; do
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  done
  for pid in "${OWNED_PIDS[@]}"; do
    wait "${pid}" 2>/dev/null || true
  done
}

cleanup() {
  if (( SHUTTING_DOWN )); then
    return 0
  fi
  SHUTTING_DOWN=1
  terminate_owned
  timeout --kill-after=2s 5s "${CODEX_BIN}" app-server daemon stop >/dev/null 2>&1 || true
}

on_signal() {
  log "received $1, shutting down"
  cleanup
  exit 0
}

on_exit() {
  local code=$?
  cleanup
  exit "${code}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  # Shutdown state and signal traps first: nothing below may run unguarded.
  trap 'on_signal TERM' TERM
  trap 'on_signal INT' INT
  trap 'on_exit' EXIT

  mkdir -p "${CODEX_HOME}" "${DOT_WORKSPACE}" "${HOME}/.cache" "${HOME}/.config"

  seed_runtime "${CODEX_SEED_HOME}" "${CODEX_HOME}"
  if [[ ! -x "${CODEX_BIN}" ]]; then
    log "FATAL: Codex binary missing at ${CODEX_BIN}"
    exit 1
  fi
  log "codex: $("${CODEX_BIN}" --version 2>/dev/null || echo unknown)"

  write_default_config
  git config --global --add safe.directory "${DOT_WORKSPACE}" 2>/dev/null || true
  if [[ "${DOT_WORKSPACE}" != "/workspace" ]]; then
    git config --global --add safe.directory /workspace 2>/dev/null || true
  fi

  seed_auth
  start_device_login

  # Independent workers: CLI/network waits never block the API or each other.
  start_api
  start_remote_worker
  start_dots_executor

  while (( SHUTTING_DOWN == 0 )); do
    sleep 30 &
    SLEEP_PID=$!
    wait "${SLEEP_PID}" 2>/dev/null || true
    SLEEP_PID=""
    (( SHUTTING_DOWN )) && break

    if [[ -z "${API_PID}" ]] || ! kill -0 "${API_PID}" 2>/dev/null; then
      log "api process is not running; restarting"
      start_api
    fi
    if [[ -z "${REMOTE_PID}" ]] || ! kill -0 "${REMOTE_PID}" 2>/dev/null; then
      log "remote-control worker is not running; restarting"
      start_remote_worker
    fi
    rotate_log "${CODEX_HOME}/remote-control.log"
    if [[ "${DOT_DOTS_EXECUTOR:-0}" == "1" ]]; then
      rotate_log "${CODEX_HOME}/dots-executor.log"
      start_dots_executor
    fi
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi