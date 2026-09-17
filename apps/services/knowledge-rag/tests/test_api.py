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

from knowledge_rag import main as knowledge_main
from knowledge_rag.api import (
    get_context_verifier,
    get_customer_evidence_retriever,
)
from knowledge_rag.trusted_context import (
    KnowledgeRagContextAssertionError,
    VerifiedKnowledgeRagContext,
)

app = knowledge_main.app


class FakeContextVerifier:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error

    def verify(self, assertion: str | None) -> VerifiedKnowledgeRagContext:
        if self.error:
            raise self.error

        assert assertion == "knowledge-rag-context"
        return VerifiedKnowledgeRagContext(
            context_id="context-1",
            tenant_id="tenant-local",
            environment_id="local",
            subject_customer_id="customer-1",
            request_id="request-1",
            trace_id="trace-1",
            routing_epoch=1,
        )


class FakeEvidenceRetriever:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def retrieve(self, *, query_text: str, context: VerifiedKnowledgeRagContext):
        self.calls.append({"query_text": query_text, "context": context})

        from knowledge_rag.embeddings import EmbeddingModel
        from knowledge_rag.retrieval_service import RetrievalExecutionResult

        return RetrievalExecutionResult(
            request={
                "query_text": query_text,
                "tenant_id": context.tenant_id,
                "environment_id": context.environment_id,
                "knowledge_release_id": "refund-policy-2026-08-01",
                "allowed_classifications": ["CUSTOMER_SAFE"],
                "locale": "en-US",
                "as_of": "2026-08-14T12:00:00Z",
                "embedding_model": EmbeddingModel(
                    provider="test",
                    model_name="test-embedding",
                    model_version="v1",
                    dimension=8,
                ),
                "top_k": 3,
            },
            embedding_model={
                "provider": "test",
                "model_name": "test-embedding",
                "model_version": "v1",
                "dimension": 8,
            },
            reranker_model={
                "provider": "test",
                "model_name": "test-reranker",
                "model_version": "v1",
            },
            fused_candidate_count=0,
            evidence=[],
        )


def enabled_runtime():
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    runtime = initialize_telemetry(
        enabled=True,
        service_name="knowledge-rag",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
        span_processor=SimpleSpanProcessor(span_exporter),
        metric_reader=metric_reader,
        log_processor=SimpleLogRecordProcessor(log_exporter),
    )
    return runtime, span_exporter, metric_reader, log_exporter


def serialized(value: Any) -> str:
    def default(item: Any) -> Any:
        if hasattr(item, "__dict__"):
            return vars(item)
        return str(item)

    return json.dumps(value, default=default, sort_keys=True)


def test_health_reports_the_knowledge_service_is_ready() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"service": "knowledge-rag", "status": "ok"}


def test_injected_runtime_emits_safe_health_telemetry() -> None:
    runtime, span_exporter, metric_reader, log_exporter = enabled_runtime()
    local_app = knowledge_main.create_app(telemetry_runtime=runtime)

    response = TestClient(local_app).get(
        "/health?secret=CANARY",
        headers={"authorization": "CANARY"},
    )

    assert response.status_code == 200
    assert runtime.force_flush() is True
    spans = span_exporter.get_finished_spans()
    assert [span.name for span in spans] == ["GET /health"]
    exported = serialized(
        [spans, metric_reader.get_metrics_data(), log_exporter.get_finished_logs()]
    )
    assert "CANARY" not in exported


def test_trace_context_does_not_bypass_knowledge_authentication() -> None:
    runtime, span_exporter, _, _ = enabled_runtime()
    local_app = knowledge_main.create_app(telemetry_runtime=runtime)
    local_app.dependency_overrides[get_context_verifier] = (
        lambda: FakeContextVerifier(error=KnowledgeRagContextAssertionError())
    )
    local_app.dependency_overrides[get_customer_evidence_retriever] = (
        lambda: FakeEvidenceRetriever()
    )

    response = TestClient(local_app).post(
        "/v1/customer-evidence",
        json={"query_text": "CANARY"},
        headers={
            "traceparent": (
                "00-11111111111111111111111111111111-2222222222222222-01"
            )
        },
    )

    assert response.status_code == 401
    assert runtime.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.context.trace_id == int("11111111111111111111111111111111", 16)
    assert "CANARY" not in serialized([span])


def test_customer_evidence_requires_trusted_context() -> None:
    app.dependency_overrides[get_context_verifier] = lambda: FakeContextVerifier(
        error=KnowledgeRagContextAssertionError()
    )
    app.dependency_overrides[get_customer_evidence_retriever] = (
        lambda: FakeEvidenceRetriever()
    )
    client = TestClient(app)

    response = client.post(
        "/v1/customer-evidence",
        json={"query_text": "Can I get a refund?"},
    )

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "context_unauthorized"
    app.dependency_overrides.clear()


def test_customer_evidence_uses_verified_context() -> None:
    retriever = FakeEvidenceRetriever()
    app.dependency_overrides[get_context_verifier] = (
        lambda: FakeContextVerifier()
    )
    app.dependency_overrides[get_customer_evidence_retriever] = lambda: retriever
    client = TestClient(app)

    response = client.post(
        "/v1/customer-evidence",
        headers={"x-cso-knowledge-context-assertion": "knowledge-rag-context"},
        json={"query_text": "Can I get a refund?"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "knowledge_release_id": "refund-policy-2026-08-01",
        "evidence": [],
    }
    assert retriever.calls[0]["query_text"] == "Can I get a refund?"
    assert retriever.calls[0]["context"].tenant_id == "tenant-local"
    app.dependency_overrides.clear()
