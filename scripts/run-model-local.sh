#!/usr/bin/env bash
# Run the decider locally and point a gateway at it.
#
#   ./scripts/run-model-local.sh              # real model, downloads 4.8 GB, ~30-60 s to load
#   ./scripts/run-model-local.sh --fake       # no model: plausible probabilities, instant
#
# The `--fake` path is the one to use for gateway work. It speaks the same protocol,
# including the cold-start headers, so everything downstream behaves identically — you just
# do not wait ten minutes to find out that a status code is wrong.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8080}"
CHECKPOINT="${CHECKPOINT:-StrandsAgents/strands-decider-2B-qwen3.5-v1-2610}"

if ! python -c "import strands_decider" 2>/dev/null && [[ "${1:-}" != "--fake" ]]; then
  cat >&2 <<EOF
strands-decider is not installed. Either:

  pip install "strands-decider @ git+https://github.com/strands-labs/strands-decider"

or run without the model, to develop the gateway:

  $0 --fake
EOF
  exit 1
fi

echo "serving on http://127.0.0.1:$PORT/v1/systemone"
if [[ "${1:-}" == "--fake" ]]; then
  echo "mode: fake (no model loaded)"
else
  echo "mode: real — loading $CHECKPOINT, 25-60 s on CPU"
fi
echo
echo "then, in another shell, point a gateway at it:"
echo "  DECIDER_URL=http://127.0.0.1:$PORT DECIDER_AUTH=none bun run dev"
echo

exec python model/devserver.py --port "$PORT" --checkpoint "$CHECKPOINT" "$@"
