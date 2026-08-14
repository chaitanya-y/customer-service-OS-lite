from fastapi.testclient import TestClient

from knowledge_rag.api import (
    get_context_verifier,
    get_customer_evidence_retriever,
)
from knowledge_rag.main import app
from knowledge_rag.trusted_context import (
    KnowledgeRagContextAssertionError,
    VerifiedKnowledgeRagContext,
)


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


def test_health_reports_the_knowledge_service_is_ready() -> None:
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"service": "knowledge-rag", "status": "ok"}


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
