#!/usr/bin/env bash
# Dots / Work local executor connector.
#
# Registers this container as a "local computer" for ChatGPT Dots/Work and
# keeps a `codex exec-server` attached to it. This is the non-Electron half of
# the connector used by the ChatGPT desktop app:
#
#   POST /flora/cca/executor            -> executor_id (environment id)
#   codex exec-server --remote ...      -> Noise executor rendezvous
#   POST /tbo/{tbo}/computers/{env}/connect-and-replace
#
# Enable with DOT_DOTS_EXECUTOR=1. Everything is configurable so a new host or
# sandbox only needs environment variables, not manual doctoring.
set -Eeuo pipefail

CODEX_HOME="${CODEX_HOME:-/data/codex}"
CODEX_BIN="${CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/bin/codex}"
DOTS_NAME="${DOT_DOTS_NAME:-$(hostname)}"
API_BASE="${DOT_CHATGPT_BASE_URL:-https://chatgpt.com/backend-api}"
REMOTE_URL="${DOT_DOTS_REMOTE_URL:-https://codex-cloud-environments.chatgpt.com/api}"
ATTACH="${DOT_DOTS_ATTACH:-1}"
POLL_SECONDS="${DOT_DOTS_POLL_SECONDS:-60}"
CONCURRENT_REQUESTS="${DOT_DOTS_CONCURRENT_REQUESTS:-32}"
INSTALLATION_FILE="${DOT_DOTS_INSTALLATION_FILE:-${CODEX_HOME}/.tpp-local-executor-installation-id}"
ENVIRONMENT_FILE="${DOT_DOTS_ENVIRONMENT_FILE:-${CODEX_HOME}/.dots-executor-environment-id}"
EXEC_LOG="${DOT_DOTS_EXEC_LOG:-${CODEX_HOME}/dots-exec-server.log}"
THREAD_ID="${DOT_DOTS_TBO_THREAD_ID:-}"
TBO_ID="${DOT_DOTS_TBO_ID:-}"
WORKSPACE="${DOT_WORKSPACE:-/workspace}"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

log() { printf '%s [dots-executor] %s\n' "$(date -Is)" "$*" >&2; }

auth_field() {
  jq -r "$1 // empty" "${CODEX_HOME}/auth.json" 2>/dev/null || true
}

http() {
  # http METHOD PATH [JSON_BODY] -> prints "HTTP_CODE", leaves body in BODY_FILE
  local method="$1" path="$2" body="${3:-}"
  local token account
  token="$(auth_field '.tokens.access_token')"
  account="$(auth_field '.tokens.account_id')"
  if [ -z "$token" ]; then
    printf '000'
    return 0
  fi
  local args=(-sS --max-time 30 -X "$method" -H "Authorization: Bearer ${token}")
  if [ -n "$account" ]; then
    args+=(-H "chatgpt-account-id: ${account}")
  fi
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  curl "${args[@]}" -o "$BODY_FILE" -w '%{http_code}' "${API_BASE}${path}" || printf '000'
}

body_json() {
  jq -c . "$BODY_FILE" 2>/dev/null || cat "$BODY_FILE" 2>/dev/null || true
}

ensure_installation_id() {
  if [ -f "$INSTALLATION_FILE" ]; then
    cat "$INSTALLATION_FILE"
    return 0
  fi
  local iid
  iid="$(cat /proc/sys/kernel/random/uuid)"
  printf '%s\n' "$iid" >"$INSTALLATION_FILE"
  chmod 600 "$INSTALLATION_FILE"
  printf '%s' "$iid"
}

register_executor() {
  local iid roots body code attempt env_id
  iid="$(ensure_installation_id)"
  roots='[]'
  if [ -d "${CODEX_HOME}/skills" ]; then
    roots="$(jq -n --arg p "${CODEX_HOME}/skills" '[{id:"codex-home-skills",path:$p}]')"
  fi
  body="$(jq -n \
    --arg name "$DOTS_NAME" \
    --arg iid "$iid" \
    --argjson roots "$roots" \
    '{displayName:$name, installation_id:$iid, selected_capability_roots:$roots}')"

  for attempt in $(seq 1 12); do
    code="$(http POST /flora/cca/executor "$body")"
    if [ "$code" = "200" ] || [ "$code" = "201" ]; then
      env_id="$(jq -r '.executor_id // empty' "$BODY_FILE")"
      if [ -n "$env_id" ]; then
        printf '%s\n' "$env_id" >"$ENVIRONMENT_FILE"
        chmod 600 "$ENVIRONMENT_FILE"
        log "registered executor ${env_id} as ${DOTS_NAME} (installation ${iid})"
        printf '%s' "$env_id"
        return 0
      fi
    fi
    log "registration attempt ${attempt} failed (HTTP ${code}); retrying"
    sleep 10
  done
  return 1
}

resolve_thread_id() {
  if [ -n "$THREAD_ID" ]; then
    printf '%s' "$THREAD_ID"
    return 0
  fi
  local code
  code="$(http GET /tbo/primary)"
  if [ "$code" != "200" ]; then
    return 1
  fi
  jq -r '.selection.thread_id // .thread_id // empty' "$BODY_FILE"
}

resolve_tbo_id() {
  local thread="$1" code
  if [ -n "$TBO_ID" ]; then
    printf '%s' "$TBO_ID"
    return 0
  fi
  code="$(http GET "/tbo/by-thread/${thread}")"
  if [ "$code" != "200" ]; then
    return 1
  fi
  jq -r '.id // empty' "$BODY_FILE"
}

attach_computer() {
  if [ "$ATTACH" != "1" ]; then
    return 0
  fi
  if [ ! -f "$ENVIRONMENT_FILE" ]; then
    log "no environment id yet; skipping attach"
    return 1
  fi
  local env_id thread tbo code attached
  env_id="$(cat "$ENVIRONMENT_FILE")"
  thread="$(resolve_thread_id)" || { log "could not resolve Dot thread"; return 1; }
  tbo="$(resolve_tbo_id "$thread")" || { log "could not resolve Dot TBO"; return 1; }
  [ -n "$env_id" ] && [ -n "$thread" ] && [ -n "$tbo" ] || return 1

  code="$(http GET "/tbo/${tbo}/computers?expected_thread_id=${thread}")"
  if [ "$code" != "200" ]; then
    log "computer list failed (HTTP ${code})"
    return 1
  fi
  attached="$(jq -r --arg env "$env_id" \
    '.computers[]? | select(.environment_id == $env) | .is_attached' "$BODY_FILE" | head -n1)"
  if [ "$attached" = "true" ]; then
    return 0
  fi
  log "attaching ${env_id} to Dot ${tbo}"
  code="$(http POST "/tbo/${tbo}/computers/${env_id}/connect-and-replace?expected_thread_id=${thread}" '{}')"
  if [ "$code" = "200" ] || [ "$code" = "204" ]; then
    log "attached ${env_id} to Dot ${tbo}"
    return 0
  fi
  log "attach failed (HTTP ${code}): $(body_json | head -c 500)"
  return 1
}

stop_child() {
  if [ -n "${CHILD:-}" ] && kill -0 "$CHILD" 2>/dev/null; then
    kill "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
}

trap 'stop_child; exit 0' TERM INT

log "starting connector for ${DOTS_NAME} (codex=${CODEX_BIN})"
while :; do
  ENV_ID="$(register_executor)" || { log "registration failed; retrying"; sleep 15; continue; }
  attach_computer || true

  log "starting exec-server for ${ENV_ID}"
  CODEX_HOME="$CODEX_HOME" \
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_work_desktop \
  CODEX_EXEC_SERVER_EXIT_ON_STDIN_CLOSE=false \
  CODEX_TASK_WORKSPACE_NODE="$WORKSPACE" \
  LOG_FORMAT=json \
  RUST_LOG="${RUST_LOG:-info},codex_exec_server::remote=info" \
  "$CODEX_BIN" -c forced_login_method="chatgpt" exec-server \
    --concurrent-requests "$CONCURRENT_REQUESTS" \
    --remote "$REMOTE_URL" \
    --environment-id "$ENV_ID" \
    </dev/null >>"$EXEC_LOG" 2>&1 &
  CHILD=$!
  log "exec-server pid=${CHILD}"

  while kill -0 "$CHILD" 2>/dev/null; do
    sleep "$POLL_SECONDS" || true
    attach_computer || true
  done
  wait "$CHILD" || true
  CHILD=""
  log "exec-server exited; restarting"
  sleep 5
done
