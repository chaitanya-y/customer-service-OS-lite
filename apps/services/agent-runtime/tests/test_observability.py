from __future__ import annotations

import json
from typing import Any

from cso_observability import TelemetryState, initialize_telemetry
from fastapi.testclient import TestClient
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from agent_runtime.main import create_app
from agent_runtime.refund.router import get_agent_runtime_context_verifier


def _serialized(value: Any) -> str:
    def default(item: Any) -> Any:
        if hasattr(item, "__dict__"):
            return vars(item)
        return str(item)

    return json.dumps(value, default=default, sort_keys=True)


def _runtime() -> tuple[Any, InMemorySpanExporter, InMemoryMetricReader, Any]:
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    runtime = initialize_telemetry(
        enabled=True,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
        span_processor=SimpleSpanProcessor(span_exporter),
        metric_reader=metric_reader,
        log_processor=SimpleLogRecordProcessor(log_exporter),
    )
    return runtime, span_exporter, metric_reader, log_exporter


def test_health_emits_safe_route_telemetry() -> None:
    runtime, span_exporter, metric_reader, log_exporter = _runtime()
    app = create_app(telemetry_runtime=runtime)

    response = TestClient(app).get(
        "/health?secret=CANARY",
        headers={"authorization": "CANARY"},
    )

    assert response.status_code == 200
    assert runtime.force_flush() is True
    spans = span_exporter.get_finished_spans()
    assert any(span.name == "GET /health" for span in spans)
    exported = _serialized(
        [spans, metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "CANARY" not in exported


def test_trace_context_does_not_bypass_refund_authentication() -> None:
    runtime, span_exporter, _, _ = _runtime()
    app = create_app(telemetry_runtime=runtime)
    app.dependency_overrides[get_agent_runtime_context_verifier] = object

    response = TestClient(app).post(
        "/refunds/intake",
        json={"customer_message": "CANARY"},
        headers={
            "traceparent": ("00-11111111111111111111111111111111-2222222222222222-01")
        },
    )

    assert response.status_code == 401
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.context.trace_id == int("11111111111111111111111111111111", 16)
    assert "CANARY" not in _serialized([span])
