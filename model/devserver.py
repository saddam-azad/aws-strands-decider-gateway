"""
A local stand-in for the Lambda function URL.

The model is expensive to build (a 6.7 GB image) and impossible to iterate against from
inside a container. This serves the same `POST /v1/systemone` contract from a plain
`http.server`, so the gateway can be run against a real checkpoint on a laptop:

    python model/devserver.py --checkpoint StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --port 8080

It deliberately re-implements the *response headers* too (`x-decider-cold-start`,
`x-decider-model-load-ms`), because those are what the gateway parses into its cold-start
metrics, and a dev server that omits them hides a whole class of bug.

It loads the real engine if `strands-decider` is importable. If it is not -- a machine
without torch, or a CI run that only wants to exercise the HTTP path -- `--fake` answers
with plausible probabilities so the gateway can be developed end to end without a GPU,
a 4.8 GB download, or ten minutes of weight loading.
"""

from __future__ import annotations

import argparse
import json
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

STATE: dict[str, Any] = {"engine": None, "load_ms": None, "checkpoint": None, "fake": False}


def load(checkpoint: str, fake: bool) -> None:
    if fake:
        STATE["fake"] = True
        STATE["load_ms"] = 0
        return
    from strands_decider.infer import load_engine

    started = time.perf_counter()
    STATE["engine"] = load_engine(checkpoint, device="cpu")
    STATE["load_ms"] = int((time.perf_counter() - started) * 1000)
    STATE["checkpoint"] = checkpoint
    print(f"[devserver] loaded {checkpoint} in {STATE['load_ms']} ms", flush=True)


def fake_answer(question: dict[str, Any]) -> Any:
    """A plausible answer per question type, using the model's own wire shapes."""
    rng = random.Random(json.dumps(question, sort_keys=True))
    kind = question.get("type")
    if kind == "choice":
        options = list(question["criteria"])
        probs = _normalised(rng, len(options))
        choice = max(range(len(options)), key=lambda i: probs[i])
        return {
            "choice": options[choice],
            "probabilities": dict(zip(options, probs)),
            "confidence": round(max(probs), 4),
        }
    if kind == "score":
        levels = len(question["criteria"])
        probs = _normalised(rng, levels)
        return {
            "probabilities": {str(i): p for i, p in enumerate(probs)},
            "score": round(sum(i * p for i, p in enumerate(probs)), 4),
            "legend": {str(i): text for i, text in enumerate(question["criteria"])},
        }
    return round(rng.uniform(0.15, 0.92), 4)


def _normalised(rng: random.Random, n: int) -> list[float]:
    raw = [rng.random() ** 2 + 0.05 for _ in range(n)]
    total = sum(raw)
    return [round(v / total, 4) for v in raw]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[devserver] {fmt % args}", flush=True)

    def _send(self, status: int, body: dict[str, Any], extra: dict[str, str] | None = None) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        if self.path in ("/health", "/ping", "/healthz"):
            self._send(200, {"ok": True, "cold": STATE["load_ms"] is None})
        else:
            self._send(404, {"error": {"code": "not_found"}})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("", "/v1/systemone", "/invocations"):
            self._send(404, {"error": {"code": "not_found"}})
            return

        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as exc:
            self._send(400, {"error": {"code": "invalid_json", "message": str(exc)}})
            return

        started = time.perf_counter()
        cold = STATE["load_ms"] is None
        if cold:
            load(STATE["checkpoint"] or "fake", STATE["fake"])

        questions = payload.get("questions") or {}
        if STATE["fake"]:
            answers = {name: fake_answer(q) for name, q in questions.items()}
            latency = random.randint(40, 200)
            time.sleep(latency / 1000)
        else:
            from strands_decider.schema import SystemOneRequest

            try:
                response = STATE["engine"].evaluate(SystemOneRequest.model_validate(payload))
            except Exception as exc:  # noqa: BLE001 - a dev server's job is to show the error
                self._send(422, {"error": {"code": "invalid_request", "message": str(exc)[:400]}})
                return
            body = json.loads(response.model_dump_json())
            answers = body["answers"]
            latency = body.get("latency_ms", int((time.perf_counter() - started) * 1000))

        total_ms = int((time.perf_counter() - started) * 1000)
        headers = {
            "x-decider-cold-start": "true" if cold else "false",
            "x-decider-model-ms": str(total_ms),
        }
        if cold:
            headers["x-decider-model-load-ms"] = str(STATE["load_ms"])

        self._send(
            200,
            {
                "model": payload.get("model") or STATE["checkpoint"] or "fake",
                "answers": answers,
                "usage": {"input_tokens": sum(len(json.dumps(q)) for q in questions.values()) // 4, "output_tokens": len(questions)},
                "latency_ms": latency,
            },
            headers,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the decider as a local HTTP server.")
    parser.add_argument("--checkpoint", default="StrandsAgents/strands-decider-2B-qwen3.5-v1-2610")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--fake",
        action="store_true",
        help="Answer with plausible probabilities instead of loading the model. For gateway work.",
    )
    args = parser.parse_args()

    STATE["checkpoint"] = args.checkpoint
    STATE["fake"] = args.fake
    if not args.fake:
        print("[devserver] loading the model; this takes 25-60 s on CPU", flush=True)
        load(args.checkpoint, fake=False)
    else:
        STATE["load_ms"] = 0

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[devserver] listening on http://{args.host}:{args.port}/v1/systemone", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
