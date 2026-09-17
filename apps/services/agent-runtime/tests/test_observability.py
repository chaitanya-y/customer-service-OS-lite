from __future__ import annotations

import json
from contextlib import asynccontextmanager
from typing import Any

import httpx
import pytest
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

import agent_runtime.integrations.order_lookup as order_lookup_module
from agent_runtime.integrations.customer_evidence import (
    CustomerEvidenceLookupUnauthorizedError,
    KnowledgeRagCustomerEvidenceClient,
)
from agent_runtime.integrations.order_lookup import (
    McpOrderLookupClient,
    OrderLookupUnavailableError,
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


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 401])
async def test_rag_dependency_propagates_parent_without_content(status: int) -> None:
    runtime, exporter, metrics, logs = _runtime()
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            status, json={"knowledge_release_id": "test", "evidence": []}
        )

    client = KnowledgeRagCustomerEvidenceClient(
        context_assertion="CANARY_ASSERTION",
        transport=httpx.MockTransport(handler),
        telemetry=runtime,
    )
    try:
        with runtime._tracer.start_as_current_span("test.parent"):
            if status == 401:
                with pytest.raises(CustomerEvidenceLookupUnauthorizedError):
                    await client.retrieve_customer_evidence("CANARY_QUERY")
            else:
                response = await client.retrieve_customer_evidence("CANARY_QUERY")
                assert response.evidence == []
        spans = exporter.get_finished_spans()
        child = next(span for span in spans if span.name == "knowledge.retrieve")
        parent = next(span for span in spans if span.name == "test.parent")
        assert child.parent.span_id == parent.context.span_id
        assert (
            captured[0].headers["traceparent"].split("-")[2]
            == f"{child.context.span_id:016x}"
        )
        assert (
            captured[0].headers["x-cso-knowledge-context-assertion"]
            == "CANARY_ASSERTION"
        )
        assert "baggage" not in captured[0].headers
        assert "tracestate" not in captured[0].headers
        assert child.status.is_ok is (status == 200)
        assert "CANARY" not in _serialized(
            [spans, metrics.get_metrics_data(), logs.get_finished_logs()]
        )
    finally:
        runtime.shutdown()


@pytest.mark.asyncio
async def test_mcp_dependency_propagates_parent_and_preserves_safe_error(
    monkeypatch,
) -> None:
    runtime, exporter, _, _ = _runtime()
    captured: list[dict[str, str]] = []

    @asynccontextmanager
    async def failing_transport(url, *, http_client):
        captured.append(dict(http_client.headers))
        raise OSError("CANARY_PRIVATE_FAILURE")
        yield  # pragma: no cover

    monkeypatch.setattr(
        order_lookup_module, "streamable_http_client", failing_transport
    )
    client = McpOrderLookupClient(
        context_assertion="CANARY_ASSERTION", telemetry=runtime
    )
    try:
        with (
            runtime._tracer.start_as_current_span("test.parent"),
            pytest.raises(OrderLookupUnavailableError),
        ):
            await client.lookup_order("CANARY_ORDER")
        spans = exporter.get_finished_spans()
        child = next(span for span in spans if span.name == "mcp.lookup_order")
        parent = next(span for span in spans if span.name == "test.parent")
        assert child.parent.span_id == parent.context.span_id
        assert (
            captured[0]["traceparent"].split("-")[2] == f"{child.context.span_id:016x}"
        )
        assert captured[0]["x-cso-context-assertion"] == "CANARY_ASSERTION"
        assert "baggage" not in captured[0]
        assert not child.status.is_ok
        assert "CANARY" not in _serialized(spans)
    finally:
        runtime.shutdown()
