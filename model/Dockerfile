# The decider, in a Fargate container.
#
# Size is the whole story here. A CPU-only torch wheel plus a 4.8 GB checkpoint lands
# around 6.7 GB, which is why this is a container image rather than a zip.
#
#   base image + python deps        ~1.9 GB
#   the checkpoint (weights)        ~4.8 GB
#   ----------------------------------------
#   image                          ~6.7 GB
#
# Weights are baked in, not downloaded at cold start. HF_HUB_OFFLINE=1 makes that
# promise enforceable: if anything in the load path tries the network, it fails loudly
# at build time rather than quietly at 3am.
FROM python:3.11-slim

# Torch from the CPU index: the default wheel drags in ~2 GB of CUDA libraries that this
# container can never use. Pinned, because the model's CPU path upcasts the torso to fp32
# and that behaviour is torch-version sensitive.
#
# numpy pinned to 1.26.4: 2.x ships source-only for this base image and requires gcc.
# transformers capped at 5.9.0: test against the model's CPU path before upgrading,
# as module layout changes can produce shape errors deep inside a forward pass.
ARG TORCH=2.6.0
ARG TRANSFORMERS=5.9.0

RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch==${TORCH}" \
 && pip install --no-cache-dir \
      "transformers==${TRANSFORMERS}" \
      "peft>=0.21" \
      "accelerate>=0.34" \
      "huggingface_hub>=1.5" \
      "safetensors>=0.4" \
      "numpy==1.26.4" \
      "pydantic>=2.7" \
      "boto3>=1.34" \
      "fastapi>=0.111" \
      "uvicorn[standard]>=0.30"

# strands-decider from a commit, not PyPI: there is no release, and the model format is
# still moving. Pass `--build-arg DECIDER_GIT_REF=<sha>` to pin a known-good commit.
ARG DECIDER_GIT_REF=main
RUN apt-get update && apt-get install -y --no-install-recommends git curl \
 && pip install --no-cache-dir --no-deps \
      "strands-decider @ git+https://github.com/strands-labs/strands-decider@${DECIDER_GIT_REF}" \
 && apt-get purge -y git && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Bake the checkpoint. One layer, so rebuilding the handler does not re-download 4.8 GB.
ENV HF_HOME=/opt/hf
ARG CHECKPOINT=StrandsAgents/strands-decider-2B-qwen3.5-v1-2610
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('Qwen/Qwen3.5-2B-Base'); \
snapshot_download('${CHECKPOINT}'); \
" \
 && du -sh /opt/hf

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false \
    PORT=8080

WORKDIR /app
COPY handler.py telemetry.py ./

EXPOSE 8080
CMD ["python", "handler.py"]
