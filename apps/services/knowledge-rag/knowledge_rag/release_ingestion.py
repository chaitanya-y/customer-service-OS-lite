from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .embeddings import EmbeddingModel, EmbeddingProvider, embed_chunks
from .index_documents import (
    IndexableKnowledgeChunk,
    build_index_documents,
)
from .ingestion import IngestionArtifact
from .opensearch_indexing import (
    BulkIndexResult,
    OpenSearchIndexingAdapter,
)
from .opensearch_schema import OpenSearchIndexConfig
from .registered_ingestion import (
    SourceUriResolver,
    ingest_registered_source,
)
from .source_registry import KnowledgeReleaseManifest


class ReleaseCompilationError(RuntimeError):
    """Raised when a complete knowledge release cannot be compiled safely."""


class KnowledgeReleaseCompilation(BaseModel):
    """
    Verified, embedded, index-ready contents for one immutable knowledge release.

    This object is built completely before any OpenSearch write occurs.
    """

    model_config = ConfigDict(frozen=True)

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    ingestion_job_id: str = Field(min_length=1)

    embedding_model: EmbeddingModel
    artifacts: list[IngestionArtifact] = Field(min_length=1)
    index_documents: list[IndexableKnowledgeChunk] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_documents(self) -> KnowledgeReleaseCompilation:
        index_document_ids = [
            document.index_document_id for document in self.index_documents
        ]

        if len(set(index_document_ids)) != len(index_document_ids):
            raise ValueError(
                "A release compilation must not contain duplicate index documents."
            )

        return self


class KnowledgeReleasePublication(BaseModel):
    """A compiled release written to its immutable OpenSearch index."""

    model_config = ConfigDict(frozen=True)

    compilation: KnowledgeReleaseCompilation
    index_result: BulkIndexResult


def compile_knowledge_release(
    *,
    manifest: KnowledgeReleaseManifest,
    source_uri_resolver: SourceUriResolver,
    embedding_provider: EmbeddingProvider,
    ingestion_job_id: str,
) -> KnowledgeReleaseCompilation:
    if not ingestion_job_id.strip():
        raise ValueError("ingestion_job_id must be non-empty")

    artifacts: list[IngestionArtifact] = []
    index_documents: list[IndexableKnowledgeChunk] = []

    for registration in manifest.registrations:
        artifact = ingest_registered_source(
            manifest=manifest,
            knowledge_document_id=registration.knowledge_document_id,
            source_uri_resolver=source_uri_resolver,
            ingestion_job_id=ingestion_job_id,
            idempotency_key=_idempotency_key(manifest, registration),
        )
        embedded_chunks = embed_chunks(
            artifact.chunks,
            embedding_provider,
        )

        artifacts.append(artifact)
        index_documents.extend(
            build_index_documents(
                artifact,
                embedded_chunks,
            )
        )

    return KnowledgeReleaseCompilation(
        tenant_id=manifest.tenant_id,
        environment_id=manifest.environment_id,
        knowledge_release_id=manifest.knowledge_release_id,
        ingestion_job_id=ingestion_job_id,
        embedding_model=embedding_provider.model,
        artifacts=artifacts,
        index_documents=index_documents,
    )


def _idempotency_key(
    manifest: KnowledgeReleaseManifest,
    registration,
) -> str:
    return (
        f"{manifest.tenant_id}:{manifest.environment_id}:"
        f"{manifest.knowledge_release_id}:"
        f"{registration.knowledge_document_id}:"
        f"{registration.source_version}:"
        f"{registration.expected_source_content_sha256}"
    )


def publish_knowledge_release(
    *,
    compilation: KnowledgeReleaseCompilation,
    index_config: OpenSearchIndexConfig,
    indexing_adapter: OpenSearchIndexingAdapter,
) -> KnowledgeReleasePublication:
    if (
        index_config.vector_dimension
        != compilation.embedding_model.dimension
    ):
        raise ReleaseCompilationError(
            "Index vector dimension must match the compilation embedding model."
        )

    index_result = indexing_adapter.index_documents(
        config=index_config,
        documents=compilation.index_documents,
        refresh=True,
    )

    return KnowledgeReleasePublication(
        compilation=compilation,
        index_result=index_result,
    )
