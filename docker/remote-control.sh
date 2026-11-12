#!/usr/bin/env bash
# Remote-control enrollment worker.
#
# Keeps this container enrolled as a connectable ChatGPT device: every 30 s
# one idempotent, time-bounded `remote-control start --json` attempt. The
# last valid status line is written atomically to dot-remote-status.json
# together with an ISO-8601 checkedAt timestamp; failures/timeouts overwrite
# any previous "connected" with "errored". The HTTP bridge reads that file
# for its diagnostics; no daemon liveness is inferred here.
set -Eeuo pipefail

export CODEX_HOME="${CODEX_HOME:-/data/codex}"
CODEX_BIN="${CODEX_BIN:-${CODEX_HOME}/packages/standalone/current/bin/codex}"
STATUS_FILE="${CODEX_HOME}/dot-remote-status.json"
INTERVAL_SECONDS="${DOT_REMOTE_INTERVAL_SECONDS:-30}"
ATTEMPT_TIMEOUT="${DOT_REMOTE_ATTEMPT_TIMEOUT:-15s}"
SHUTTING_DOWN=0
SLEEP_PID=""

log() { printf '%s [remote-control] %s\n' "$(date -Is)" "$*" >&2; }

record_remote_status() {
  # record_remote_status STATUS_JSON -> atomic status + checkedAt
  local final="$1" tmp="${STATUS_FILE}.tmp"
  if ! printf '%s' "${final}" | jq -e 'type == "object"' >/dev/null 2>&1; then
    final='{"status":"errored","serverName":null,"environmentId":null}'
  fi
  jq -c --arg checkedAt "$(date -Is)" '. + {checkedAt: $checkedAt}' <<<"${final}" >"${tmp}"
  mv -f "${tmp}" "${STATUS_FILE}"
  log "status: $(jq -c '{status, checkedAt}' "${STATUS_FILE}")"
}

attempt_enrollment() {
  local output final
  output="$(timeout --kill-after=2s "${ATTEMPT_TIMEOUT}" "${CODEX_BIN}" remote-control start --json 2>&1)" || true
  # Mixed log/JSON output: keep the last valid status object line.
  final="$(printf '%s\n' "${output}" | jq -Rrc 'fromjson? | select(type == "object" and .status != null)' 2>/dev/null | tail -n 1 || true)"
  if [[ -z "${final}" ]]; then
    final='{"status":"errored","serverName":null,"environmentId":null}'
  fi
  record_remote_status "${final}"
}

on_signal() {
  SHUTTING_DOWN=1
  if [[ -n "${SLEEP_PID}" ]]; then
    kill "${SLEEP_PID}" 2>/dev/null || true
  fi
  exit 0
}

main() {
  trap 'on_signal' TERM INT
  log "worker started (codex=${CODEX_BIN}, interval=${INTERVAL_SECONDS}s)"
  while (( SHUTTING_DOWN == 0 )); do
    attempt_enrollment
    (( SHUTTING_DOWN )) && break
    sleep "${INTERVAL_SECONDS}" &
    SLEEP_PID=$!
    wait "${SLEEP_PID}" 2>/dev/null || true
    SLEEP_PID=""
  done
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi