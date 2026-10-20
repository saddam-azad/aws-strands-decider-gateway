# The decider, in a container Lambda.
#
# Size is the whole story here. A CPU-only torch wheel plus a 4.8 GB checkpoint lands
# around 6.7 GB, which is why this is a container image rather than a zip (250 MB limit)
# and why the function is configured for 10240 MB in lib/stack.ts.
#
#   base image + python deps        ~1.9 GB
#   the checkpoint (weights)        ~4.8 GB
#   ----------------------------------------
#   image                          ~6.7 GB   (Lambda's own limit is 10 GB)
#
# Weights are baked in, not downloaded at cold start. A cold start that reaches out to
# the Hugging Face Hub would be slower, would need egress, and would fail the moment the
# Hub had a bad day. `HF_HUB_OFFLINE=1` then makes that promise enforceable: if anything
# in the load path tries the network, it fails loudly at build-verification time rather
# than quietly at 3am.
FROM public.ecr.aws/lambda/python:3.11

# Torch from the CPU index: the default wheel drags in ~2 GB of CUDA libraries that this
# function can never use. Pinned, because the model's CPU path upcasts the torso to fp32
# and that behaviour is torch-version sensitive.
#
# transformers is capped below 5.20 deliberately: 5.20.0 changed the Qwen3.5 module
# layout in a way 2.7.1's ops do not match, and the failure is a shape error deep inside
# a forward pass rather than an import error.
ARG TORCH=2.7.1
ARG TRANSFORMERS=5.19.0

RUN pip install --no-cache-dir \
      --index-url https://download.pytorch.org/whl/cpu \
      "torch==${TORCH}" \
 && pip install --no-cache-dir \
      "transformers==${TRANSFORMERS}" \
      "peft>=0.21" \
      "accelerate>=0.34" \
      "huggingface_hub>=1.5" \
      "safetensors>=0.4" \
      "numpy>=1.24" \
      "pydantic>=2.7" \
      "boto3>=1.34"

# strands-decider from a commit, not PyPI: there is no release, and the model format is
# still moving. Pass `--build-arg DECIDER_GIT_REF=<sha>` to pin a known-good commit; the
# default is the commit this project was built against.
ARG DECIDER_GIT_REF=main
RUN pip install --no-cache-dir \
      "strands-decider @ git+https://github.com/strands-labs/strands-decider@${DECIDER_GIT_REF}"

# Bake the checkpoint. One layer, so rebuilding the handler does not re-download 4.8 GB:
#   - the 2B torso (Qwen/Qwen3.5-2B-Base, Apache-2.0, ungated)
#   - the trained adapter + head for this release
#
# HF_HOME is /opt/hf so the Hub cache is inside the image and survives into the runtime:
# Lambda only keeps /tmp writable, and /tmp is per-execution-environment.
ENV HF_HOME=/opt/hf
ARG CHECKPOINT=StrandsAgents/strands-decider-2B-qwen3.5-v1-2610
RUN python -c "\
from huggingface_hub import snapshot_download; \
snapshot_download('Qwen/Qwen3.5-2B-Base'); \
snapshot_download('${CHECKPOINT}'); \
" \
 && du -sh /opt/hf

# Offline from here on. A missing file becomes an error at load, not a long stall.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    PYTHONUNBUFFERED=1 \
    OMP_NUM_THREADS=4 \
    TOKENIZERS_PARALLELISM=false

COPY handler.py telemetry.py ${LAMBDA_TASK_ROOT}/

# The handler loads the engine lazily on first invoke; see handler.py for why that is
# Lambda's INIT phase and is billed accordingly (25-60 s, once per execution environment).
CMD ["handler.handler"]
