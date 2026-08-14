from datetime import UTC, datetime

from knowledge_rag.config import KnowledgeRetrievalSettings
from knowledge_rag.customer_evidence import ConfiguredCustomerEvidenceRetriever
from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.retrieval_service import RetrievalExecutionResult
from knowledge_rag.trusted_context import VerifiedKnowledgeRagContext


class FakeRetrievalService:
    def __init__(self) -> None:
        self.requests = []

    def retrieve(self, request):
        self.requests.append(request)
        return RetrievalExecutionResult(
            request=request,
            embedding_model=request.embedding_model,
            reranker_model={
                "provider": "test",
                "model_name": "test-reranker",
                "model_version": "v1",
            },
            fused_candidate_count=0,
            evidence=[],
        )


def test_customer_evidence_uses_trusted_context_and_customer_safe_filter() -> None:
    settings = KnowledgeRetrievalSettings.model_validate(
        {
            "OPENAI_API_KEY": "test-key",
            "TENANT_ID": "tenant-local",
            "ENVIRONMENT_ID": "local",
            "CONTEXT_ASSERTION_HMAC_SECRET": "context-secret-at-least-32-bytes",
            "CONTEXT_ASSERTION_ISSUER": "customer-service-os-edge",
            "KNOWLEDGE_RELEASE_ID": "refund-policy-2026-08-01",
            "KNOWLEDGE_INDEX_NAME": "cso-knowledge-tenant-local-local-v1",
        }
    )
    service = FakeRetrievalService()
    embedding_model = EmbeddingModel(
        provider="test",
        model_name="test-embedding",
        model_version="v1",
        dimension=8,
    )
    retriever = ConfiguredCustomerEvidenceRetriever(
        settings=settings,
        retrieval_service=service,  # type: ignore[arg-type]
        embedding_model=embedding_model,
        now=lambda: datetime(2026, 8, 14, 12, 0, tzinfo=UTC),
    )

    result = retriever.retrieve(
        query_text="Can I refund a damaged item?",
        context=VerifiedKnowledgeRagContext(
            context_id="context-1",
            tenant_id="tenant-local",
            environment_id="local",
            subject_customer_id="customer-1",
            request_id="request-1",
            trace_id="trace-1",
            routing_epoch=1,
        ),
    )

    assert result.evidence == []
    request = service.requests[0]
    assert request.tenant_id == "tenant-local"
    assert request.environment_id == "local"
    assert request.knowledge_release_id == "refund-policy-2026-08-01"
    assert request.allowed_classifications == [
        KnowledgeDocumentClassification.CUSTOMER_SAFE
    ]
    assert request.locale == "en-US"
