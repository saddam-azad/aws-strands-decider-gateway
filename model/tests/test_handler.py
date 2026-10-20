"""
Tests for the model handler's HTTP contract.

These run *without* torch and without the checkpoint: `strands_decider` is replaced in
`sys.modules` with a stub before `handler` is imported, so what is under test is the
handler's own logic -- status codes, error shapes, cold-start attribution, the headers the
gateway parses -- rather than the model, which cannot be unit-tested in 10 seconds anyway.

The real model's correctness is a different problem, owned by the strands-decider project
and its own test suite. What this file asserts is that *this* function speaks the protocol
the gateway expects.
"""

from __future__ import annotations

import json
import sys
import types
from typing import Any

import pytest


# ---------------------------------------------------------------------------- stubs


class _Usage:
    def __init__(self, input_tokens: int = 10, output_tokens: int = 1) -> None:
        self.input_tokens = input_tokens
        self.output_tokens = output_tokens


class _Response:
    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.usage = _Usage()
        self.model = "stub"

    def model_dump_json(self) -> str:
        return json.dumps({"model": self.model, "answers": self.answers, "usage": {"input_tokens": 10, "output_tokens": 1}})


class _Engine:
    """Mimics SystemOneEngine.evaluate: returns one calibrated answer per question."""

    def __init__(self, fail: bool = False) -> None:
        self.fail = fail

    def evaluate(self, request: Any) -> _Response:
        if self.fail:
            raise RuntimeError("stub inference failure")
        answers: dict[str, Any] = {}
        for name, question in request.questions.items():
            kind = getattr(question, "type", None) or (question.get("type") if isinstance(question, dict) else None)
            if kind == "score":
                answers[name] = {"probabilities": {"0": 0.2, "1": 0.8}, "score": 1.8, "legend": {"0": "low", "1": "high"}}
            elif kind == "choice":
                answers[name] = {"choice": "a", "probabilities": {"a": 0.75, "b": 0.25}, "confidence": 0.75}
            else:
                answers[name] = 0.66
        return _Response(answers)


def _install_stub() -> None:
    """Register a fake `strands_decider` package before the handler imports it."""
    package = types.ModuleType("strands_decider")
    package.__version__ = "0.0.0-test"

    infer = types.ModuleType("strands_decider.infer")
    infer.load_engine = lambda checkpoint, **_: _Engine()  # type: ignore[attr-defined]

    schema = types.ModuleType("strands_decider.schema")

    class _ValidationError(Exception):
        pass

    class SystemOneRequest:
        def __init__(self, **kwargs: Any) -> None:
            self.questions = kwargs.get("questions", {})
            self.state = kwargs.get("state")
            self.model = kwargs.get("model")

        @classmethod
        def model_validate(cls, payload: dict[str, Any]) -> "SystemOneRequest":
            if not isinstance(payload, dict):
                raise _ValidationError("payload must be an object")
            if "questions" not in payload:
                raise _ValidationError("Field required: questions")
            return cls(**payload)

    schema.SystemOneRequest = SystemOneRequest  # type: ignore[attr-defined]
    package.infer = infer  # type: ignore[attr-defined]
    package.schema = schema  # type: ignore[attr-defined]
    sys.modules["strands_decider"] = package
    sys.modules["strands_decider.infer"] = infer
    sys.modules["strands_decider.schema"] = schema


_install_stub()
sys.path.insert(0, __file__.rsplit("/", 2)[0])
import handler as model  # noqa: E402


# ------------------------------------------------------------------------- fixtures


@pytest.fixture(autouse=True)
def _reset_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each test starts with a cold engine, and a single known model."""
    monkeypatch.setenv("MODEL_MAP", json.dumps({"decider-2b": "local/stub-checkpoint"}))
    monkeypatch.setenv("DEFAULT_MODEL", "decider-2b")
    monkeypatch.setattr(model, "MODEL_MAP", {"decider-2b": "local/stub-checkpoint"})
    monkeypatch.setattr(model, "DEFAULT_MODEL", "decider-2b")
    monkeypatch.setattr(model, "_ENGINE", None)
    monkeypatch.setattr(model, "_LOAD_MS", None)
    monkeypatch.setattr(model, "_LOADING_MODEL", None)


def request(method: str = "POST", body: Any = None, base64: bool = False) -> dict[str, Any]:
    if body is not None and not isinstance(body, str):
        body = json.dumps(body)
    if base64 and body is not None:
        import base64 as b64

        body = b64.b64encode(body.encode()).decode()
    return {
        "version": "2.0",
        "rawPath": "/v1/systemone",
        "requestContext": {"requestId": "test-request-id", "http": {"method": method, "path": "/v1/systemone"}},
        "body": body or "",
        "isBase64Encoded": base64,
    }


def body_of(response: dict[str, Any]) -> dict[str, Any]:
    return json.loads(response["body"])


# ---------------------------------------------------------------------------- tests


def test_answers_all_three_question_types() -> None:
    payload = {
        "state": "a support ticket",
        "questions": {
            "escalate": {"type": "noul", "instructions": "Should this be escalated?"},
            "route": {"type": "choice", "instructions": "Where?", "criteria": {"a": "billing", "b": "engineering"}},
            "severity": {"type": "score", "instructions": "How bad?", "criteria": ["low", "high"]},
        },
    }
    response = model.handler(request(body=payload), None)
    assert response["statusCode"] == 200

    body = body_of(response)
    assert body["answers"]["escalate"] == 0.66
    assert body["answers"]["route"]["choice"] == "a"
    assert body["answers"]["severity"]["score"] == 1.8
    assert body["latency_ms"] >= 0


def test_reports_cold_start_on_the_first_request_and_warm_after() -> None:
    payload = {"state": "s", "questions": {"q": {"type": "noul", "instructions": "Is it?"}}}

    first = model.handler(request(body=payload), None)
    assert first["headers"]["x-decider-cold-start"] == "true"
    assert int(first["headers"]["x-decider-model-load-ms"]) >= 0

    second = model.handler(request(body=payload), None)
    assert second["headers"]["x-decider-cold-start"] == "false"
    assert "x-decider-model-load-ms" not in second["headers"]


def test_always_reports_model_time() -> None:
    response = model.handler(request(body={"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}}), None)
    assert int(response["headers"]["x-decider-model-ms"]) >= 0


def test_rejects_a_get() -> None:
    response = model.handler(request(method="GET"), None)
    assert response["statusCode"] == 405


def test_rejects_a_non_json_body() -> None:
    response = model.handler(request(body="{not json"), None)
    assert response["statusCode"] == 400
    assert body_of(response)["error"]["code"] == "invalid_json"


def test_rejects_a_missing_questions_field() -> None:
    response = model.handler(request(body={"state": "s"}), None)
    assert response["statusCode"] == 422
    assert body_of(response)["error"]["code"] == "invalid_request"


def test_rejects_an_unknown_model_alias() -> None:
    response = model.handler(request(body={"model": "decider-70b", "state": "s", "questions": {}}), None)
    assert response["statusCode"] == 400
    assert body_of(response)["error"]["code"] == "unknown_model"
    assert "decider-70b" in body_of(response)["error"]["message"]


def test_rejects_too_many_questions(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(model, "MAX_QUESTIONS", 2)
    payload = {"state": "s", "questions": {f"q{i}": {"type": "noul", "instructions": "x"} for i in range(3)}}
    response = model.handler(request(body=payload), None)
    assert response["statusCode"] == 400
    assert body_of(response)["error"]["code"] == "too_many_questions"


def test_an_inference_failure_is_a_500_with_no_internal_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    # Simulate a warm environment: an engine is already resident, so this request never
    # touches the load path and the failure that follows is purely an inference failure.
    monkeypatch.setattr(model, "_ENGINE", _Engine(fail=True))
    monkeypatch.setattr(model, "_LOAD_MS", 12)
    monkeypatch.setattr(model, "_LOADING_MODEL", "decider-2b")
    response = model.handler(request(body={"state": "s", "questions": {"q": {"type": "noul", "instructions": "x"}}}), None)
    assert response["statusCode"] == 500
    error = body_of(response)["error"]
    assert error["code"] == "inference_failed"
    assert "stub inference failure" not in json.dumps(error), "the caller must not see the traceback"


def test_decodes_a_base64_body() -> None:
    response = model.handler(request(body={"state": "s", "questions": {}}, base64=True), None)
    assert response["statusCode"] == 200


def test_version_header_is_present() -> None:
    response = model.handler(request(body={"state": "s", "questions": {}}), None)
    assert response["headers"]["x-decider-version"] == "0.0.0-test"
