from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable
from typing import Any

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from opentelemetry._logs import SeverityNumber
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from cso_observability import TelemetryState, initialize_telemetry


def _serialized_values(values: Iterable[Any]) -> str:
    def default(value: Any) -> Any:
        if hasattr(value, "__dict__"):
            return vars(value)
        return str(value)

    return json.dumps(list(values), default=default, sort_keys=True)


def _enabled_runtime() -> tuple[Any, InMemorySpanExporter, InMemoryMetricReader, Any]:
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


def test_disabled_runtime_does_not_export() -> None:
    runtime = initialize_telemetry(
        enabled=False,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
    )
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    runtime.attach_asgi(app)
    assert TestClient(app).get("/health").status_code == 200
    assert runtime.force_flush() is True
    assert runtime.enabled is False
    assert runtime.trace_headers() == {}

    with runtime.operation("rag.query_embedding"):
        assert runtime.trace_headers() == {}


def test_operation_is_an_active_child_and_emits_only_safe_signals() -> None:
    runtime, span_exporter, metric_reader, log_exporter = _enabled_runtime()

    with runtime.operation("knowledge.retrieve"):
        parent_headers = runtime.trace_headers()
        with runtime.operation("rag.query_embedding"):
            child_headers = runtime.trace_headers()

    assert runtime.force_flush() is True
    spans = {span.name: span for span in span_exporter.get_finished_spans()}
    parent = spans["knowledge.retrieve"]
    child = spans["rag.query_embedding"]
    assert child.parent is not None
    assert child.parent.span_id == parent.context.span_id
    assert set(parent_headers) == {"traceparent"}
    assert set(child_headers) == {"traceparent"}
    assert parent_headers["traceparent"].startswith("00-")
    assert child_headers["traceparent"].startswith("00-")
    assert parent_headers["traceparent"].split("-")[1] == (
        child_headers["traceparent"].split("-")[1]
    )

    exported = _serialized_values(
        [spans, metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "operation.completed" in exported
    assert "http.response.status_code" not in exported


def test_operation_records_safe_application_error_and_reraises_unchanged() -> None:
    runtime, span_exporter, metric_reader, log_exporter = _enabled_runtime()
    error = RuntimeError("RAW-OPERATION-CANARY")

    with (
        pytest.raises(RuntimeError) as caught,
        runtime.operation("rag.vector_search"),
    ):
        raise error

    assert caught.value is error
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.name == "rag.vector_search"
    assert span.attributes == {
        "operation": "rag.vector_search",
        "outcome": "server_error",
        "error.type": "application_error",
    }
    assert span.events == ()
    assert span.status.description is None
    exported = _serialized_values(
        [[span], metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "RAW-OPERATION-CANARY" not in exported


def test_operation_rejects_unbounded_names() -> None:
    runtime, _, _, _ = _enabled_runtime()

    with (
        pytest.raises(ValueError, match="bounded static name"),
        runtime.operation("rag.CANARY"),
    ):
        pass


def test_initialization_is_idempotent_for_one_state() -> None:
    state = TelemetryState()
    first = initialize_telemetry(
        enabled=False,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=state,
    )
    second = initialize_telemetry(
        enabled=True,
        service_name="ignored-after-initialization",
        service_version="ignored",
        environment_name="ignored",
        state=state,
    )

    assert second is first
    assert second.enabled is False


def test_success_uses_route_template_and_emits_safe_signals() -> None:
    runtime, span_exporter, metric_reader, log_exporter = _enabled_runtime()
    app = FastAPI()

    @app.get("/widgets/{widget_id}")
    async def widget(widget_id: str) -> dict[str, str]:
        return {"widget": widget_id}

    runtime.attach_asgi(app)
    response = TestClient(app).get(
        "/widgets/SECRET-PATH?secret=CANARY",
        headers={"authorization": "Bearer CANARY"},
    )

    assert response.status_code == 200
    assert runtime.force_flush() is True
    spans = span_exporter.get_finished_spans()
    assert [span.name for span in spans] == ["GET /widgets/{widget_id}"]
    assert spans[0].attributes["operation"] == "GET /widgets/{widget_id}"
    assert spans[0].attributes["outcome"] == "success"
    assert spans[0].attributes["http.response.status_code"] == 200
    assert spans[0].resource.attributes == {
        "service.name": "agent-runtime",
        "service.version": "test",
        "deployment.environment.name": "test",
    }
    finished_log = log_exporter.get_finished_logs()[0]
    assert finished_log.log_record.timestamp is not None
    assert finished_log.log_record.severity_number is SeverityNumber.INFO
    exported = _serialized_values(
        [spans, metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "request.completed" in exported
    assert "SECRET-PATH" not in exported
    assert "CANARY" not in exported


def test_traceparent_becomes_parent_without_accepting_baggage() -> None:
    runtime, span_exporter, _, _ = _enabled_runtime()
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    runtime.attach_asgi(app)
    trace_id_hex = "11111111111111111111111111111111"
    parent_span_id_hex = "2222222222222222"
    response = TestClient(app).get(
        "/health",
        headers={
            "traceparent": f"00-{trace_id_hex}-{parent_span_id_hex}-01",
            "baggage": "secret=CANARY",
        },
    )

    assert response.status_code == 200
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.context.trace_id == int(trace_id_hex, 16)
    assert span.parent is not None
    assert span.parent.span_id == int(parent_span_id_hex, 16)
    assert "CANARY" not in _serialized_values([span])


def test_application_error_has_no_exception_event_or_description() -> None:
    runtime, span_exporter, metric_reader, log_exporter = _enabled_runtime()
    app = FastAPI()

    @app.get("/failure")
    async def failure() -> None:
        raise HTTPException(status_code=503, detail="RAW-EXCEPTION-CANARY")

    runtime.attach_asgi(app)
    response = TestClient(app).get("/failure")

    assert response.status_code == 503
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.attributes["outcome"] == "server_error"
    assert span.attributes["http.response.status_code"] == 503
    assert span.events == ()
    assert span.status.description is None
    exported = _serialized_values(
        [[span], metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "RAW-EXCEPTION-CANARY" not in exported


def test_unknown_routes_use_bounded_unmatched_operation() -> None:
    runtime, span_exporter, _, _ = _enabled_runtime()
    app = FastAPI()
    runtime.attach_asgi(app)

    response = TestClient(app).get("/raw-secret-CANARY")

    assert response.status_code == 404
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.name == "GET unmatched"
    assert "CANARY" not in _serialized_values([span])


def test_shutdown_returns_within_its_bound_when_export_is_blocked() -> None:
    class BlockingSpanExporter(SpanExporter):
        def export(self, spans: Any) -> SpanExportResult:
            time.sleep(1)
            return SpanExportResult.SUCCESS

        def shutdown(self) -> None:
            return None

    metric_reader = InMemoryMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    runtime = initialize_telemetry(
        enabled=True,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
        span_processor=BatchSpanProcessor(
            BlockingSpanExporter(),
            schedule_delay_millis=60_000,
        ),
        metric_reader=metric_reader,
        log_processor=SimpleLogRecordProcessor(log_exporter),
    )
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    runtime.attach_asgi(app)
    assert TestClient(app).get("/health").status_code == 200

    started_at = time.monotonic()
    completed = runtime.shutdown(timeout_seconds=0.02)

    assert completed is False
    assert time.monotonic() - started_at < 0.2
    assert runtime.shutdown(timeout_seconds=0.02) is False


def test_unavailable_collector_only_emits_a_fixed_safe_diagnostic(caplog: Any) -> None:
    runtime = initialize_telemetry(
        enabled=True,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        endpoint="http://127.0.0.1:1",
        state=TelemetryState(),
    )
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    runtime.attach_asgi(app)
    with caplog.at_level(logging.ERROR):
        response = TestClient(app).get(
            "/health?secret=CANARY",
            headers={"authorization": "CANARY"},
        )
        runtime.force_flush(timeout_millis=200)

    assert response.status_code == 200
    assert "telemetry.unavailable" in [record.getMessage() for record in caplog.records]
    assert all(record.exc_info is None for record in caplog.records)
    assert "CANARY" not in _serialized_values(caplog.records)
    runtime.shutdown(timeout_seconds=0.2)


def test_invalid_enabled_configuration_degrades_to_disabled() -> None:
    diagnostics: list[str] = []

    runtime = initialize_telemetry(
        enabled=True,
        service_name="agent runtime with unsafe spaces",
        service_version="test",
        environment_name="test",
        endpoint="https://collector.example.test?token=CANARY",
        state=TelemetryState(),
        diagnostic=diagnostics.append,
    )

    assert runtime.enabled is False
    assert diagnostics == ["telemetry.unavailable"]


def test_throwing_exporter_is_sanitized_and_rate_limited(caplog: Any) -> None:
    class ThrowingSpanExporter(SpanExporter):
        def export(self, spans: Any) -> SpanExportResult:
            raise RuntimeError("RAW-EXPORTER-CANARY")

        def shutdown(self) -> None:
            return None

    runtime = initialize_telemetry(
        enabled=True,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
        span_processor=BatchSpanProcessor(
            ThrowingSpanExporter(),
            schedule_delay_millis=60_000,
        ),
        metric_reader=InMemoryMetricReader(),
        log_processor=SimpleLogRecordProcessor(InMemoryLogRecordExporter()),
    )
    app = FastAPI()

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    runtime.attach_asgi(app)
    with caplog.at_level(logging.ERROR):
        assert TestClient(app).get("/health").status_code == 200
        runtime.force_flush(timeout_millis=200)
        assert TestClient(app).get("/health").status_code == 200
        runtime.force_flush(timeout_millis=200)

    records = [
        record
        for record in caplog.records
        if record.getMessage() == "telemetry.unavailable"
    ]
    assert len(records) == 1
    assert records[0].exc_info is None
    assert "RAW-EXPORTER-CANARY" not in _serialized_values(caplog.records)
    runtime.shutdown(timeout_seconds=0.2)
