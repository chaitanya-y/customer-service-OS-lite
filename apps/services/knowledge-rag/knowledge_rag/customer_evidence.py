from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Protocol

from .config import KnowledgeRetrievalSettings
from .embeddings import EmbeddingModel, OpenAIEmbeddingProvider
from .ingestion import KnowledgeDocumentClassification
from .opensearch_local import create_local_opensearch_client
from .opensearch_retrieval import RetrievalRequest
from .reranking import SentenceTransformersCrossEncoderProvider
from .retrieval_service import (
    KnowledgeRetrievalService,
    RetrievalExecutionResult,
)
from .trusted_context import VerifiedKnowledgeRagContext


class CustomerEvidenceRetriever(Protocol):
    def retrieve(
        self,
        *,
        query_text: str,
        context: VerifiedKnowledgeRagContext,
    ) -> RetrievalExecutionResult:
        """Retrieve customer-safe evidence using only trusted request context."""


class ConfiguredCustomerEvidenceRetriever:
    def __init__(
        self,
        *,
        settings: KnowledgeRetrievalSettings,
        retrieval_service: KnowledgeRetrievalService,
        embedding_model: EmbeddingModel,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._retrieval_service = retrieval_service
        self._embedding_model = embedding_model
        self._now = now or (lambda: datetime.now(UTC))

    def retrieve(
        self,
        *,
        query_text: str,
        context: VerifiedKnowledgeRagContext,
    ) -> RetrievalExecutionResult:
        request = RetrievalRequest(
            query_text=query_text,
            tenant_id=context.tenant_id,
            environment_id=context.environment_id,
            knowledge_release_id=self._settings.knowledge_release_id,
            allowed_classifications=[
                KnowledgeDocumentClassification.CUSTOMER_SAFE
            ],
            locale=self._settings.knowledge_locale,
            as_of=self._now(),
            embedding_model=self._embedding_model,
            top_k=self._settings.customer_evidence_top_k,
        )

        return self._retrieval_service.retrieve(request)


def create_configured_customer_evidence_retriever(
    settings: KnowledgeRetrievalSettings,
) -> ConfiguredCustomerEvidenceRetriever:
    embedding_provider = OpenAIEmbeddingProvider(
        api_key=settings.openai_api_key.get_secret_value()
    )

    retrieval_service = KnowledgeRetrievalService(
        client=create_local_opensearch_client(),
        index_name=settings.knowledge_index_name,
        embedding_provider=embedding_provider,
        reranking_provider=SentenceTransformersCrossEncoderProvider(),
    )

    return ConfiguredCustomerEvidenceRetriever(
        settings=settings,
        retrieval_service=retrieval_service,
        embedding_model=embedding_provider.model,
    )
