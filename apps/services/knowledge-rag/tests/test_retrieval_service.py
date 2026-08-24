from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from knowledge_rag.embeddings import (
    DeterministicEmbeddingProvider,
    EmbeddingModel,
)
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.opensearch_retrieval import RetrievalRequest
from knowledge_rag.reranking import DeterministicRerankingProvider
from knowledge_rag.retrieval_service import (
    KnowledgeRetrievalService,
    RetrievalServiceError,
)


class FakeSearchClient:
    def __init__(self, *responses: Mapping[str, Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def search(
        self,
        *,
        index: str,
        body: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        self.calls.append({"index": index, "body": dict(body)})
        return self._responses.pop(0)


def make_request(
    embedding_model: EmbeddingModel,
    *,
    top_k: int = 2,
) -> RetrievalRequest:
    return RetrievalRequest(
        query_text="Can I get a refund for a damaged item?",
        tenant_id="acme",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=[
            KnowledgeDocumentClassification.CUSTOMER_SAFE
        ],
        locale="en-US",
        as_of=datetime(2026, 8, 11, 12, 0, tzinfo=UTC),
        embedding_model=embedding_model,
        top_k=top_k,
    )


def make_hit(
    *,
    chunk_id: str,
    content: str,
    score: float,
) -> dict[str, object]:
    return {
        "_score": score,
        "_source": {
            "index_document_id": f"index-{chunk_id}",
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": chunk_id,
            "content": content,
            "content_sha256": "a" * 64,
            "knowledge_release_id": "refund-policy-2026-08-01",
            "tenant_id": "acme",
            "environment_id": "local",
            "classification": "CUSTOMER_SAFE",
            "locale": "en-US",
            "source_uri": "s3://cso-knowledge/acme/refund-policy.md",
            "title": "Acme Refund Policy",
            "section_path": ["Acme Refund Policy", chunk_id],
        },
    }


def make_response(*hits: dict[str, object]) -> dict[str, object]:
    return {"hits": {"hits": list(hits)}}


def test_retrieve_runs_governed_hybrid_retrieval_and_reranking() -> None:
    embedding_provider = DeterministicEmbeddingProvider(dimension=8)
    client = FakeSearchClient(
        make_response(
            make_hit(
                chunk_id="damaged-items",
                content="A damaged item refund is available.",
                score=0.9,
            ),
            make_hit(
                chunk_id="shipping",
                content="Shipping details are available.",
                score=0.7,
            ),
        ),
        make_response(
            make_hit(
                chunk_id="damaged-items",
                content="A damaged item refund is available.",
                score=12.0,
            ),
            make_hit(
                chunk_id="final-sale",
                content="Final-sale items cannot be refunded.",
                score=10.0,
            ),
        ),
    )
    service = KnowledgeRetrievalService(
        client=client,
        index_name="cso-knowledge-acme-local-v1",
        embedding_provider=embedding_provider,
        reranking_provider=DeterministicRerankingProvider(),
        candidate_pool_size=4,
    )

    result = service.retrieve(make_request(embedding_provider.model))

    assert result.fused_candidate_count == 3
    assert len(result.evidence) == 2
    assert result.evidence[0].fused_evidence.evidence.chunk_id == (
        "damaged-items"
    )
    assert result.embedding_model == embedding_provider.model
    assert result.reranker_model.provider == "deterministic"

    assert len(client.calls) == 2
    assert client.calls[0]["index"] == "cso-knowledge-acme-local-v1"
    assert client.calls[0]["body"]["size"] == 4
    assert client.calls[1]["body"]["size"] == 4

    vector_filters = client.calls[0]["body"]["query"]["knn"][
        "embedding_vector"
    ]["filter"]["bool"]["filter"]
    keyword_filters = client.calls[1]["body"]["query"]["bool"]["filter"]

    assert vector_filters == keyword_filters
    assert {"term": {"tenant_id": "acme"}} in vector_filters
    assert {"term": {"environment_id": "local"}} in vector_filters
    assert {
        "term": {"knowledge_release_id": "refund-policy-2026-08-01"}
    } in vector_filters


def test_retrieve_rejects_an_embedding_model_mismatch() -> None:
    embedding_provider = DeterministicEmbeddingProvider(dimension=8)
    service = KnowledgeRetrievalService(
        client=FakeSearchClient(),
        index_name="cso-knowledge-acme-local-v1",
        embedding_provider=embedding_provider,
        reranking_provider=DeterministicRerankingProvider(),
    )
    wrong_model = EmbeddingModel(
        provider="openai",
        model_name="text-embedding-3-small",
        model_version="openai-embeddings-v1",
        dimension=1536,
    )

    with pytest.raises(
        RetrievalServiceError,
        match="embedding model must match",
    ):
        service.retrieve(make_request(wrong_model))


def test_retrieve_rejects_a_final_count_larger_than_candidate_pool() -> None:
    embedding_provider = DeterministicEmbeddingProvider(dimension=8)
    service = KnowledgeRetrievalService(
        client=FakeSearchClient(),
        index_name="cso-knowledge-acme-local-v1",
        embedding_provider=embedding_provider,
        reranking_provider=DeterministicRerankingProvider(),
        candidate_pool_size=2,
    )

    with pytest.raises(
        RetrievalServiceError,
        match="top_k cannot exceed candidate_pool_size",
    ):
        service.retrieve(make_request(embedding_provider.model, top_k=3))


def test_retrieve_rejects_an_embedding_provider_with_no_query_vector() -> None:
    class NoVectorEmbeddingProvider:
        model = EmbeddingModel(
            provider="test",
            model_name="no-vector",
            model_version="v1",
            dimension=8,
        )

        def embed_documents(self, texts: list[str]) -> list[list[float]]:
            return []

    embedding_provider = NoVectorEmbeddingProvider()
    service = KnowledgeRetrievalService(
        client=FakeSearchClient(),
        index_name="cso-knowledge-acme-local-v1",
        embedding_provider=embedding_provider,
        reranking_provider=DeterministicRerankingProvider(),
    )

    with pytest.raises(
        RetrievalServiceError,
        match="one vector for the query",
    ):
        service.retrieve(make_request(embedding_provider.model))
