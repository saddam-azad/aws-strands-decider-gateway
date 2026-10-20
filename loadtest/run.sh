#!/usr/bin/env bash
# Run a load test against a deployed gateway.
#
#   ./run.sh baseline          # 10 users, one request each
#   ./run.sh load              # ramp past the model's concurrency ceiling
#   ./run.sh burst             # everything at once
#   ./run.sh coldstart         # every request a cache miss
#   ./run.sh quota             # exceed a tenant's hourly limit
#   ./run.sh mixed             # all question shapes, all tenants
#
# Env: LOAD_MAX (peak VUs for `load`/`burst`, default 50), TIMEOUT_MS (default 60000).
#
# Needs loadtest/config.json, which `bun run setup` writes after a deploy.
set -euo pipefail
cd "$(dirname "$0")"

SCENARIO="${1:-baseline}"

if ! command -v k6 >/dev/null 2>&1; then
  cat >&2 <<'EOF'
k6 is not installed. It is a single binary:

  # macOS
  brew install k6

  # Debian/Ubuntu
  sudo gpg -k
  sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
    --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
  echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
    | sudo tee /etc/apt/sources.list.d/k6.list
  sudo apt-get update && sudo apt-get install k6

  # or: docker run --rm -i --network host grafana/k6 run - < gateway.js

https://grafana.com/docs/k6/latest/set-up/install-k6/
EOF
  exit 1
fi

if [ ! -f config.json ]; then
  echo "loadtest/config.json is missing." >&2
  echo "Deploy first (bun run deploy), then seed keys: bun run setup" >&2
  exit 1
fi

echo "scenario: $SCENARIO  (LOAD_MAX=${LOAD_MAX:-50})"
SCENARIO="$SCENARIO" k6 run gateway.js
