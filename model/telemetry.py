"""
The model container's own telemetry, deliberately independent of the gateway's.

The gateway records what the *caller* did. This records what the *model* cost. They meet
in Athena on `request_id`, which is how "which tenants are paying for cold starts" becomes
a query rather than a guess. Keeping the two writers apart also means a broken Firehose
stream on one side cannot take the other's evidence with it.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

NAMESPACE = os.environ.get("METRICS_NAMESPACE", "StrandsDeciderGateway")
STREAM = os.environ.get("USAGE_STREAM")
SERVICE = "strands-decider-model"

_units = {
    "Latency": "Milliseconds",
    "ModelLoadTime": "Milliseconds",
    "InputTokens": "Count",
    "OutputTokens": "Count",
    "Requests": "Count",
    "ColdStart": "Count",
}

_firehose: Any | None = None


def log(stage: str, fields: dict[str, Any] | None = None) -> None:
    """One JSON line, so CloudWatch Logs Insights can filter on `stage`."""
    print(json.dumps({"level": "INFO", "stage": stage, **(fields or {})}), flush=True)


def log_exception(stage: str, request_id: str | None) -> None:
    import traceback

    print(
        json.dumps(
            {
                "level": "ERROR",
                "stage": stage,
                "request_id": request_id,
                "trace": traceback.format_exc(),
            }
        ),
        flush=True,
    )


def emit_metrics(values: dict[str, float | int | None], dimensions: dict[str, str] | None = None) -> None:
    """CloudWatch Embedded Metric Format: metrics are log lines, so no API call on the hot path."""
    present = {k: v for k, v in values.items() if v is not None}
    if not present:
        return
    dims = {"Service": SERVICE, **(dimensions or {})}
    body: dict[str, Any] = {
        "_aws": {
            "Timestamp": int(time.time() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    "Dimensions": [list(dims)],
                    "Metrics": [
                        {"Name": name, "Unit": _units.get(name, "Count")} for name in present
                    ],
                }
            ],
        },
        **dims,
        **present,
    }
    print(json.dumps(body), flush=True)


def ship_record(record: dict[str, Any]) -> None:
    """Append one record to Firehose. Losing it must never fail the caller's request."""
    global _firehose
    if not STREAM:
        return
    try:
        if _firehose is None:
            import boto3  # in the container's layer, not on the hot path

            _firehose = boto3.client("firehose")
        _firehose.put_record(
            DeliveryStreamName=STREAM,
            Record={"Data": (json.dumps(record, default=str) + "\n").encode("utf-8")},
        )
    except Exception:
        # Note the request_id is only correlatable in logs, deliberately: a telemetry
        # failure must not affect the response the caller is about to receive.
        log_exception("usage_record_failed", record.get("request_id"))
