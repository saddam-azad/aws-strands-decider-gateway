#!/usr/bin/env bash
# The local development loop: the model (fake), then the gateway against it.
#
#   bun run dev
#
# That is: run `model/devserver.py --fake` on :8080 in the background, wait until it answers,
# run the gateway on :3000, and clean the model up on exit. The whole thing takes about two
# seconds and needs no AWS account, no torch and no checkpoint download.
#
# For the real model instead of the fake:
#
#   bun run model:local            # in one shell, loads the 4.8 GB checkpoint
#   DECIDER_URL=http://127.0.0.1:8080 bun run scripts/dev-server.ts   # in another
#
# The gateway half is `scripts/dev-server.ts`; read its comment for what dev auth means.
set -euo pipefail
cd "$(dirname "$0")/.."

MODEL_PORT="${MODEL_PORT:-8080}"
GATEWAY_PORT="${GATEWAY_PORT:-3000}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for the fake model (model/devserver.py --fake)" >&2
  exit 1
fi

echo "starting the fake model on :$MODEL_PORT"
python3 model/devserver.py --port "$MODEL_PORT" --fake >/tmp/opencode/devserver.log 2>&1 &
MODEL_PID=$!
trap 'kill "$MODEL_PID" 2>/dev/null || true' EXIT

# Wait for the model rather than sleeping a guessed amount. Without this, `bun run dev`
# races: the gateway's first request is a connection refused and looks like a config bug.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$MODEL_PORT/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then
    echo "the fake model died on startup; see /tmp/opencode/devserver.log" >&2
    exit 1
  fi
  sleep 0.1
done

echo "starting the gateway on :$GATEWAY_PORT"
DECIDER_URL="http://127.0.0.1:$MODEL_PORT" PORT="$GATEWAY_PORT" node scripts/dev-server.ts
