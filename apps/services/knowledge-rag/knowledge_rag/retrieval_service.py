from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .embeddings import EmbeddingModel, EmbeddingProvider
from .hybrid_retrieval import fuse_retrieval_responses
from .opensearch_retrieval import (
    RetrievalRequest,
    build_filtered_keyword_query,
    build_filtered_knn_query,
)
from .reranking import (
    RerankedEvidence,
    RerankerModel,
    RerankingProvider,
    rerank_fused_evidence,
)


class RetrievalServiceError(RuntimeError):
    """Raised when a governed retrieval operation cannot complete safely."""


class OpenSearchSearchClient(Protocol):
    """The small OpenSearch capability this service needs."""

    def search(
        self,
        *,
        index: str,
        body: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        """Run one already-governed OpenSearch query."""


class RetrievalExecutionResult(BaseModel):
    """Cited evidence returned after retrieval, fusion, and reranking."""

    model_config = ConfigDict(frozen=True)

    request: RetrievalRequest
    embedding_model: EmbeddingModel
    reranker_model: RerankerModel
    fused_candidate_count: int = Field(ge=0)
    evidence: list[RerankedEvidence]


class KnowledgeRetrievalService:
    def __init__(
        self,
        *,
        client: OpenSearchSearchClient,
        index_name: str,
        embedding_provider: EmbeddingProvider,
        reranking_provider: RerankingProvider,
        candidate_pool_size: int = 20,
    ) -> None:
        if not index_name.strip():
            raise ValueError("index_name must be non-empty")

        if candidate_pool_size <= 0:
            raise ValueError("candidate_pool_size must be positive")

        self._client = client
        self._index_name = index_name
        self._embedding_provider = embedding_provider
        self._reranking_provider = reranking_provider
        self._candidate_pool_size = candidate_pool_size

    def retrieve(
        self,
        request: RetrievalRequest,
    ) -> RetrievalExecutionResult:
        if request.embedding_model != self._embedding_provider.model:
            raise RetrievalServiceError(
                "Retrieval request embedding model must match the configured "
                "embedding provider."
            )

        if request.top_k > self._candidate_pool_size:
            raise RetrievalServiceError(
                "Retrieval request top_k cannot exceed candidate_pool_size."
            )

        query_vector = self._embed_query(request.query_text)
        candidate_request = request.model_copy(
            update={"top_k": self._candidate_pool_size}
        )

        vector_response = self._client.search(
            index=self._index_name,
            body=build_filtered_knn_query(
                candidate_request,
                query_vector,
            ),
        )
        keyword_response = self._client.search(
            index=self._index_name,
            body=build_filtered_keyword_query(candidate_request),
        )

        fused_evidence = fuse_retrieval_responses(
            vector_response=vector_response,
            keyword_response=keyword_response,
            top_k=self._candidate_pool_size,
        )
        reranked_evidence = rerank_fused_evidence(
            query_text=request.query_text,
            candidates=fused_evidence,
            provider=self._reranking_provider,
            top_k=request.top_k,
        )

        return RetrievalExecutionResult(
            request=request,
            embedding_model=self._embedding_provider.model,
            reranker_model=self._reranking_provider.model,
            fused_candidate_count=len(fused_evidence),
            evidence=reranked_evidence,
        )

    def _embed_query(self, query_text: str) -> list[float]:
        vectors = self._embedding_provider.embed_documents([query_text])

        if len(vectors) != 1:
            raise RetrievalServiceError(
                "Embedding provider must return one vector for the query."
            )

        return vectors[0]
