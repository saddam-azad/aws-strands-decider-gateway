"""
The decider itself, as a Fargate HTTP service.

Shape of the thing: a 4.8 GB checkpoint (Qwen3.5-2B-Base plus a trained adapter) loaded
onto CPU inside a 10 GB task, answering `POST /v1/systemone` with the model's own wire
format and nothing else. All of the gateway's concerns -- auth, tenancy, quotas, caching,
confidence gating -- live on the other side of the internal ALB. This process does one job.

Why CPU and not a GPU: the alternative (a Fargate service pinned to a GPU instance) is a
different, much more expensive architecture. CPU inference of a 2B torso costs ~3-5 s per
request warm. That is the whole reason the gateway is allowed to retry, caches aggressively,
and gates on confidence rather than pretending this is fast.
"""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from telemetry import emit_metrics, log, log_exception, ship_record

DECIDER_VERSION = "unknown"

# ----------------------------------------------------------------------------- config

MEMORY_MB = int(os.environ.get("TASK_MEMORY_MB", "10240"))
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "decider-2b")
MODEL_MAP: dict[str, str] = json.loads(os.environ.get("MODEL_MAP", "{}"))
MAX_QUESTIONS = int(os.environ.get("MAX_QUESTIONS", "32"))
PORT = int(os.environ.get("PORT", "8080"))

_ENGINE: Any | None = None
_LOAD_MS: int | None = None
_LOADING_MODEL: str | None = None
_STARTUP_ERROR: str | None = None


class UnknownModel(Exception):
    pass


def checkpoint_for(alias: str | None) -> tuple[str, str]:
    name = alias or DEFAULT_MODEL
    checkpoint = MODEL_MAP.get(name)
    if checkpoint is None:
        raise UnknownModel(
            f"unknown model {name!r}; this deployment serves {sorted(MODEL_MAP) or 'nothing'}"
        )
    return name, checkpoint


def engine(alias: str) -> tuple[Any, int]:
    global _ENGINE, _LOAD_MS, _LOADING_MODEL
    if _ENGINE is not None:
        if _LOADING_MODEL != alias:
            raise UnknownModel(
                f"this task has {_LOADING_MODEL!r} loaded and cannot load "
                f"{alias!r} as well; scale to a second deployment for two models"
            )
        return _ENGINE, _LOAD_MS or 0

    _alias, checkpoint = checkpoint_for(alias)
    started = time.perf_counter()
    log("model_load_start", {"model": alias, "checkpoint": checkpoint, "memory_mb": MEMORY_MB})
    from strands_decider import __version__ as _v
    from strands_decider.infer import load_engine
    global DECIDER_VERSION
    DECIDER_VERSION = _v
    _ENGINE = load_engine(checkpoint, device="cpu")
    _LOAD_MS = int((time.perf_counter() - started) * 1000)
    _LOADING_MODEL = alias
    log("model_load_done", {"model": alias, "checkpoint": checkpoint, "model_load_ms": _LOAD_MS})
    emit_metrics(
        {"ModelLoadTime": _LOAD_MS, "ColdStart": 1},
        {"Service": "strands-decider-model", "Model": alias},
    )
    return _ENGINE, _LOAD_MS


# --------------------------------------------------------------------------- app

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eagerly load the default model at startup so the first request is not a cold start.
    # Failures are logged but do not prevent uvicorn from starting — /healthz stays reachable
    # so ECS can distinguish "container up, model not yet loaded" from "container dead".
    try:
        engine(DEFAULT_MODEL)
    except Exception as exc:
        global _STARTUP_ERROR
        _STARTUP_ERROR = str(exc)[:400]
        log_exception("startup_model_load_failed", None)
        import sys
        print(f"[handler] STARTUP FAILED: {exc}", file=sys.stderr, flush=True)
    yield


app = FastAPI(lifespan=lifespan)


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message}},
        headers={"x-decider-version": DECIDER_VERSION},
    )


@app.get("/healthz")
async def healthz():
    if _STARTUP_ERROR:
        return JSONResponse(status_code=500, content={"status": "error", "error": _STARTUP_ERROR})
    return {"status": "ok", "model_loaded": _ENGINE is not None}


@app.post("/v1/systemone")
async def systemone(request: Request) -> Response:
    request_id = request.headers.get("x-request-id", "unknown")
    started = time.perf_counter()

    try:
        payload = await request.json()
    except Exception:
        return _error(400, "invalid_json", "body is not JSON")

    try:
        alias, _checkpoint = checkpoint_for(payload.get("model"))
    except UnknownModel as exc:
        return _error(400, "unknown_model", str(exc))

    from strands_decider.schema import SystemOneRequest
    try:
        req = SystemOneRequest.model_validate(payload)
    except Exception as exc:
        log("validation_failed", {"request_id": request_id, "error": str(exc)[:400]})
        return _error(422, "invalid_request", str(exc).split("\n", 1)[0][:300])

    if len(req.questions) > MAX_QUESTIONS:
        return _error(400, "too_many_questions", f"at most {MAX_QUESTIONS} questions per request")

    cold = _ENGINE is None
    try:
        active_engine, load_ms = engine(alias)
    except UnknownModel as exc:
        return _error(400, "unknown_model", str(exc))
    except Exception:
        log_exception("model_load_failed", request_id)
        return _error(500, "model_load_failed", "the model could not be loaded")

    try:
        response = active_engine.evaluate(req)
    except Exception:
        log_exception("inference_failed", request_id)
        return _error(500, "inference_failed", "the model failed to answer")

    total_ms = int((time.perf_counter() - started) * 1000)

    headers = {
        "x-decider-version": DECIDER_VERSION,
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
    log(
        "inference",
        {
            "request_id": request_id,
            "model": alias,
            "questions": len(req.questions),
            "latency_ms": total_ms,
            "cold_start": cold,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
        },
    )
    ship_record(
        {
            "request_id": request_id,
            "ts": _iso_now(),
            "model": alias,
            "questions": len(req.questions),
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
    return Response(
        content=json.dumps(body),
        media_type="application/json",
        headers=headers,
    )


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


logging.basicConfig(level=logging.INFO)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
