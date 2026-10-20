#!/usr/bin/env bash
# Build the model image locally, without deploying.
#
#   ./scripts/build-model-image.sh                 # build
#   ./scripts/build-model-image.sh --push          # build and push to ECR
#   DECIDER_GIT_REF=<sha> ./scripts/build-model-image.sh
#
# This is a ~6.7 GB image and the checkpoint download is ~4.8 GB, so the first build is
# dominated by network, not compute. Run it with a good connection and enough disk
# (about 25 GB free: the layer cache plus the final image plus the Hub cache).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${TAG:-strands-decider-model:local}"
DECIDER_GIT_REF="${DECIDER_GIT_REF:-main}"

echo "building $TAG"
echo "  DECIDER_GIT_REF=$DECIDER_GIT_REF"
echo "  context: model/"
echo
echo "the weight download dominates; this is 20-60 minutes on a first run"
echo

docker build \
  --platform linux/amd64 \
  --build-arg "DECIDER_GIT_REF=$DECIDER_GIT_REF" \
  -t "$TAG" \
  model/

echo
docker images "$TAG" --format 'built: {{.Repository}}:{{.Tag}}  {{.Size}}'
echo
echo "check the size is under the 10 GB Lambda limit before deploying:"
echo "  docker run --rm $TAG python -c \"import os; print(sum(os.path.getsize(os.path.join(d,f)) for d,_,fs in os.walk('/opt') for f in fs)//2**30, 'GB in /opt')\""
