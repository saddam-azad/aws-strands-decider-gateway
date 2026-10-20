"""
The decider itself, as a Lambda function URL handler.

Shape of the thing: a 4.8 GB checkpoint (Qwen3.5-2B-Base plus a trained adapter) loaded
onto CPU inside a 10 GB function, answering `POST /v1/systemone` with the model's own
wire format and nothing else. All of the gateway's concerns -- auth, tenancy, quotas,
caching, confidence gating -- live on the other side of the Function URL. This process
does one job.

Why a container rather than a zip: the CPU-only torch wheel alone is ~200 MB compressed
and the checkpoint is 4.8 GB, so this is far past the 250 MB zip limit. See Dockerfile.

Why CPU and not a GPU: Lambda has no GPUs, and the alternative (a Fargate service pinned
to a GPU instance) is a different, much more expensive architecture. CPU inference of a
2B torso costs ~3-5 s per request warm. That is the whole reason the gateway is allowed
to retry, caches aggressively, and gates on confidence rather than pretending this is fast.
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

# Imported at module scope on purpose. Lambda's INIT phase runs this once per execution
# environment, which is exactly when we want to pay for it: the 25-60 s the model needs to
# load from `/opt/hf` is billed as INIT, and every warm invocation then skips it.
from strands_decider import __version__ as DECIDER_VERSION
from strands_decider.infer import load_engine
from strands_decider.schema import SystemOneRequest

from telemetry import emit_metrics, log, log_exception, ship_record

log_line = log  # aliased to keep the module-level name short in handlers

# ----------------------------------------------------------------------------- config

# Lambda sets AWS_LAMBDA_FUNCTION_MEMORY_SIZE; the model needs ~9 GB resident for a 2B
# checkpoint in fp32, so the stack sets 10240. Warn loudly rather than OOM mid-request.
MEMORY_MB = int(os.environ.get("AWS_LAMBDA_FUNCTION_MEMORY_SIZE", "10240"))
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "decider-2b")
MODEL_MAP: dict[str, str] = json.loads(os.environ.get("MODEL_MAP", "{}"))

# The gateway's per-attempt deadline is 45 s. Anything slower than this will be retried
# anyway, so a request we cannot finish is better refused than half-served.
MAX_QUESTIONS = int(os.environ.get("MAX_QUESTIONS", "32"))
# The torso is loaded once and reused; a request that arrives during INIT waits rather
# than loading a second copy, which would not fit in memory.
_ENGINE: Any | None = None
_LOAD_MS: int | None = None
# The alias `_ENGINE` holds. A 2B fp32 torso is ~9 GB, so a second model cannot be loaded
# beside the first: a request for an alias we did not load is an error, not a reload.
_LOADING_MODEL: str | None = None


class UnknownModel(Exception):
    """The caller asked for a model this deployment does not have. A 400, not a 500."""


def checkpoint_for(alias: str | None) -> tuple[str, str]:
    """Resolve an alias to (alias, checkpoint). Defaults to the deployment's default model."""
    name = alias or DEFAULT_MODEL
    checkpoint = MODEL_MAP.get(name)
    if checkpoint is None:
        raise UnknownModel(
            f"unknown model {name!r}; this deployment serves {sorted(MODEL_MAP) or 'nothing'}"
        )
    return name, checkpoint


def engine(alias: str) -> tuple[Any, int]:
    """Load the model once per execution environment.

    Returns the engine and the load time in milliseconds. Lambda's INIT phase runs the
    first call, which is exactly when we want to pay the 25-60 s: every warm invocation
    then skips it. Only one model is ever resident; see `_LOADING_MODEL`.
    """
    global _ENGINE, _LOAD_MS, _LOADING_MODEL
    if _ENGINE is not None:
        if _LOADING_MODEL != alias:
            # Not a reload: the previous model is still occupying the function's memory.
            raise UnknownModel(
                f"this execution environment has {_LOADING_MODEL!r} loaded and cannot load "
                f"{alias!r} as well; scale to a second deployment for two models"
            )
        return _ENGINE, _LOAD_MS or 0

    _alias, checkpoint = checkpoint_for(alias)
    started = time.perf_counter()
    log_line("model_load_start", {"model": alias, "checkpoint": checkpoint, "memory_mb": MEMORY_MB})
    # CPU force-upcasts the torso to fp32, which is why the function needs 10 GB.
    _ENGINE = load_engine(checkpoint, device="cpu")
    _LOAD_MS = int((time.perf_counter() - started) * 1000)
    _LOADING_MODEL = alias
    log_line("model_load_done", {"model": alias, "checkpoint": checkpoint, "model_load_ms": _LOAD_MS})
    emit_metrics(
        {"ModelLoadTime": _LOAD_MS, "ColdStart": 1},
        {"Service": "strands-decider-model", "Model": alias},
    )
    return _ENGINE, _LOAD_MS


# ------------------------------------------------------------------------------ http


def _response(status: int, body: dict[str, Any], extra: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json",
            "x-decider-version": DECIDER_VERSION,
            **(extra or {}),
        },
        "body": json.dumps(body),
    }


def _error(status: int, code: str, message: str) -> dict[str, Any]:
    return _response(status, {"error": {"code": code, "message": message}})


def handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Function URL (payload v2) entry point."""
    request_id = (event.get("requestContext") or {}).get("requestId") or "unknown"
    started = time.perf_counter()

    if (event.get("requestContext") or {}).get("http", {}).get("method", "POST") != "POST":
        return _error(405, "method_not_allowed", "POST /v1/systemone")

    raw = event.get("body") or ""
    if event.get("isBase64Encoded"):
        import base64

        raw = base64.b64decode(raw).decode("utf-8")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_json", f"body is not JSON: {exc}")

    try:
        alias, _checkpoint = checkpoint_for(payload.get("model"))
    except UnknownModel as exc:
        return _error(400, "unknown_model", str(exc))

    # The gateway validates too. This is defence in depth: the Function URL is reachable by
    # anything holding the IAM grant, and a schema error must be a 400 rather than a 500
    # three seconds into a forward pass.
    try:
        request = SystemOneRequest.model_validate(payload)
    except Exception as exc:  # pydantic.ValidationError, and anything it wraps
        log_line("validation_failed", {"request_id": request_id, "error": str(exc)[:400]})
        return _error(422, "invalid_request", _short_validation(exc))

    if len(request.questions) > MAX_QUESTIONS:
        return _error(400, "too_many_questions", f"at most {MAX_QUESTIONS} questions per request")

    # Whether this invocation is paying for the load is known *before* we call the model,
    # and asking afterwards cannot recover it: a warm request that outlives a short load
    # time would look cold. Capture it here.
    cold = _ENGINE is None
    try:
        active_engine, load_ms = engine(alias)
    except UnknownModel as exc:
        return _error(400, "unknown_model", str(exc))
    except Exception:
        log_exception("model_load_failed", request_id)
        return _error(500, "model_load_failed", "the model could not be loaded")

    try:
        response = active_engine.evaluate(request)
    except Exception:
        log_exception("inference_failed", request_id)
        return _error(500, "inference_failed", "the model failed to answer")

    total_ms = int((time.perf_counter() - started) * 1000)

    headers = {
        "x-decider-cold-start": "true" if cold else "false",
        "x-decider-model-ms": str(total_ms),
    }
    if cold:
        headers["x-decider-model-load-ms"] = str(load_ms)

    usage = response.usage
    emit_metrics(
        {
            "Latency": total_ms,
            "Requests": 1,
            "ColdStart": 1 if cold else 0,
            "InputTokens": usage.input_tokens,
            "OutputTokens": usage.output_tokens,
        },
        {"Service": "strands-decider-model", "Model": alias},
    )
    log_line(
        "inference",
        {
            "request_id": request_id,
            "model": alias,
            "questions": len(request.questions),
            "latency_ms": total_ms,
            "cold_start": cold,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
        },
    )
    # The gateway's own record is the authoritative one for billing; this stream exists so
    # the model's cost can be joined to it on request_id.
    ship_record(
        {
            "request_id": request_id,
            "ts": _iso_now(),
            "model": alias,
            "questions": len(request.questions),
            "latency_ms": total_ms,
            "cold_start": cold,
            "model_load_ms": _LOAD_MS if cold else None,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "device": "cpu",
        }
    )

    body = json.loads(response.model_dump_json())
    body["latency_ms"] = total_ms
    return _response(200, body, headers)


def _short_validation(exc: Exception) -> str:
    """A pydantic error is long; the first line names the offending field."""
    text = str(exc)
    return text.split("\n", 1)[0][:300]


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


logging.basicConfig(level=logging.INFO)
