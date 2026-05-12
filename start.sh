#!/usr/bin/env bash
set -euo pipefail

# Defaults — Railway sets PORT; WORKER_PORT is internal only.
: "${PORT:=3000}"
: "${WORKER_PORT:=8080}"
: "${HOSTNAME:=0.0.0.0}"

echo "[start] launching worker on :${WORKER_PORT}"
( cd /app && WORKER_PORT="${WORKER_PORT}" npx --no-install tsx worker/index.ts ) &
WORKER_PID=$!

echo "[start] launching next.js on :${PORT}"
( cd /app && PORT="${PORT}" HOSTNAME="${HOSTNAME}" node server.js ) &
APP_PID=$!

term() {
  echo "[start] received signal, shutting down"
  kill -TERM "${APP_PID}" "${WORKER_PID}" 2>/dev/null || true
  wait "${APP_PID}" "${WORKER_PID}" 2>/dev/null || true
  exit 0
}
trap term SIGTERM SIGINT

# Exit as soon as either child dies, then kill the other so Railway restarts.
wait -n "${APP_PID}" "${WORKER_PID}"
EXIT_CODE=$?
echo "[start] one process exited (code=${EXIT_CODE}), tearing down"
kill -TERM "${APP_PID}" "${WORKER_PID}" 2>/dev/null || true
wait "${APP_PID}" "${WORKER_PID}" 2>/dev/null || true
exit "${EXIT_CODE}"
