from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .embeddings import EmbeddedChunk, EmbeddingModel
from .ingestion import (
    IngestionArtifact,
    KnowledgeDocumentClassification,
)


class IndexPreparationError(ValueError):
    """Raised when governed chunks and embeddings cannot safely be joined."""


class IndexableKnowledgeChunk(BaseModel):
    """
    The complete governed record to be written to an OpenSearch index.

    This is intentionally independent of a specific OpenSearch client. The next
    module will convert this record into an OpenSearch bulk-index request.
    """

    model_config = ConfigDict(frozen=True)

    index_document_id: str = Field(min_length=1)

    ingestion_job_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)

    knowledge_document_id: str = Field(min_length=1)
    source_document_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)

    chunk_id: str = Field(min_length=1)
    parent_section_id: str = Field(min_length=1)
    chunk_ordinal_within_section: int = Field(ge=1)

    title: str = Field(min_length=1)
    section_path: list[str] = Field(min_length=1)
    page_start: int | None = Field(default=None, gt=0)
    page_end: int | None = Field(default=None, gt=0)

    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    source_uri: str = Field(min_length=1)
    source_content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    embedding_vector: list[float] = Field(min_length=1)
    embedding_model: EmbeddingModel

    classification: KnowledgeDocumentClassification
    locale: str = Field(min_length=1)
    effective_from: str | None = None
    effective_until: str | None = None

    parser_version: str = Field(min_length=1)
    chunking_strategy_version: str = Field(min_length=1)
    artifact_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    @model_validator(mode="after")
    def validate_vector_and_page_range(self) -> IndexableKnowledgeChunk:
        if len(self.embedding_vector) != self.embedding_model.dimension:
            raise ValueError(
                "Embedding vector length must match embedding model dimension"
            )

        if not all(math.isfinite(value) for value in self.embedding_vector):
            raise ValueError("Embedding vector values must be finite")

        has_only_one_page_boundary = (self.page_start is None) != (
            self.page_end is None
        )
        if has_only_one_page_boundary:
            raise ValueError(
                "page_start and page_end must be supplied together"
            )

        if (
            self.page_start is not None
            and self.page_end is not None
            and self.page_end < self.page_start
        ):
            raise ValueError("page_end cannot be before page_start")

        return self


def build_index_documents(
    artifact: IngestionArtifact,
    embedded_chunks: Sequence[EmbeddedChunk],
) -> list[IndexableKnowledgeChunk]:
    chunk_by_id = {chunk.chunk_id: chunk for chunk in artifact.chunks}

    if len(chunk_by_id) != len(artifact.chunks):
        raise IndexPreparationError("Ingestion artifact contains duplicate chunk IDs")

    embedded_chunk_by_id: dict[str, EmbeddedChunk] = {}
    for embedded_chunk in embedded_chunks:
        if embedded_chunk.chunk_id in embedded_chunk_by_id:
            raise IndexPreparationError(
                "Embedding results contain duplicate chunk IDs"
            )

        embedded_chunk_by_id[embedded_chunk.chunk_id] = embedded_chunk

    expected_chunk_ids = set(chunk_by_id)
    received_chunk_ids = set(embedded_chunk_by_id)

    missing_chunk_ids = expected_chunk_ids - received_chunk_ids
    unexpected_chunk_ids = received_chunk_ids - expected_chunk_ids

    if missing_chunk_ids or unexpected_chunk_ids:
        raise IndexPreparationError(
            "Embedding results must contain exactly the artifact chunk IDs. "
            f"Missing: {sorted(missing_chunk_ids)}. "
            f"Unexpected: {sorted(unexpected_chunk_ids)}."
        )

    embedding_models = {
        embedded_chunk.embedding_model.model_dump_json()
        for embedded_chunk in embedded_chunks
    }
    if len(embedding_models) > 1:
        raise IndexPreparationError(
            "All chunks in one indexing operation must use the same embedding model"
        )

    index_documents: list[IndexableKnowledgeChunk] = []

    for chunk in artifact.chunks:
        embedded_chunk = embedded_chunk_by_id[chunk.chunk_id]

        if (
            embedded_chunk.content_sha256.lower()
            != chunk.content_sha256.lower()
        ):
            raise IndexPreparationError(
                f"Embedding content hash does not match chunk '{chunk.chunk_id}'."
            )

        index_documents.append(
            IndexableKnowledgeChunk(
                index_document_id=_index_document_id(
                    tenant_id=artifact.tenant_id,
                    environment_id=artifact.environment_id,
                    knowledge_release_id=artifact.knowledge_release_id,
                    knowledge_document_id=artifact.knowledge_document_id,
                    chunk_id=chunk.chunk_id,
                ),
                ingestion_job_id=artifact.ingestion_job_id,
                knowledge_release_id=artifact.knowledge_release_id,
                tenant_id=artifact.tenant_id,
                environment_id=artifact.environment_id,
                knowledge_document_id=artifact.knowledge_document_id,
                source_document_id=artifact.source_document_id,
                source_version=artifact.source_version,
                chunk_id=chunk.chunk_id,
                parent_section_id=chunk.parent_section_id,
                chunk_ordinal_within_section=(
                    chunk.chunk_ordinal_within_section
                ),
                title=chunk.title,
                section_path=chunk.section_path,
                page_start=chunk.page_start,
                page_end=chunk.page_end,
                content=chunk.content,
                content_sha256=chunk.content_sha256,
                source_uri=chunk.source_uri,
                source_content_sha256=chunk.source_content_sha256,
                embedding_vector=embedded_chunk.vector,
                embedding_model=embedded_chunk.embedding_model,
                classification=artifact.classification,
                locale=artifact.locale,
                effective_from=artifact.effective_from,
                effective_until=artifact.effective_until,
                parser_version=artifact.parser_version,
                chunking_strategy_version=(
                    artifact.chunking_strategy_version
                ),
                artifact_sha256=artifact.artifact_sha256,
            )
        )

    return index_documents


def _index_document_id(
    *,
    tenant_id: str,
    environment_id: str,
    knowledge_release_id: str,
    knowledge_document_id: str,
    chunk_id: str,
) -> str:
    identity = (
    f"{tenant_id}\0{environment_id}\0{knowledge_release_id}\0"
    f"{knowledge_document_id}\0{chunk_id}"
    )
    return f"knowledge-{hashlib.sha256(identity.encode()).hexdigest()}"