#!/usr/bin/env bash
# Qualify a built dot image offline: run test/image.test.js inside a
# disposable container created from the image itself (no bind mounts, no
# external network). Requires DOT_TEST_IMAGE and a reachable Docker daemon;
# a missing value or daemon is an error, never a skip.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${DOT_TEST_IMAGE:-}" ]]; then
  echo "verify-image: DOT_TEST_IMAGE must name the built image to verify" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "verify-image: Docker daemon is not reachable" >&2
  exit 1
fi
if ! docker image inspect "${DOT_TEST_IMAGE}" >/dev/null 2>&1; then
  echo "verify-image: image ${DOT_TEST_IMAGE} does not exist locally; build it first" >&2
  exit 1
fi

CONTAINER="dot-verify-$$-${RANDOM}"
cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --network none: the smoke test must pass without any external network.
docker create --network none --entrypoint node --name "${CONTAINER}" \
  "${DOT_TEST_IMAGE}" /app/test/image.test.js >/dev/null
docker cp "${SCRIPT_DIR}/test" "${CONTAINER}:/app/test"

set +e
docker start -a "${CONTAINER}"
set -e

exit_code="$(docker inspect "${CONTAINER}" --format '{{.State.ExitCode}}')"
if [[ "${exit_code}" != "0" ]]; then
  echo "verify-image: image tests failed (exit ${exit_code}); container logs:" >&2
  docker logs "${CONTAINER}" >&2 || true
  exit 1
fi
echo "verify-image: ${DOT_TEST_IMAGE} passed"