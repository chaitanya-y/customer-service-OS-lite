from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from .chunking import ChunkDraft, ChunkingConfig, chunk_document
from .models import ExtractionWarning, SourceContentType
from .parsers import parse_source


class KnowledgeDocumentClassification(StrEnum):
    CUSTOMER_SAFE = "CUSTOMER_SAFE"
    INTERNAL = "INTERNAL"
    RESTRICTED = "RESTRICTED"


class SourceContentHashMismatchError(ValueError):
    """Raised when the registered source revision differs from the file read."""


class SourceContentTypeMismatchError(ValueError):
    """Raised when the registered source type differs from the parsed file."""


class IngestionRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    ingestion_job_id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)

    knowledge_release_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)

    knowledge_document_id: str = Field(min_length=1)
    source_document_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)

    classification: KnowledgeDocumentClassification
    locale: str = Field(min_length=1)
    effective_from: str | None = None
    effective_until: str | None = None

    source_path: Path
    source_uri: str = Field(min_length=1)
    expected_source_content_type: SourceContentType
    expected_source_content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    chunking_config: ChunkingConfig = Field(default_factory=ChunkingConfig)


class IngestionArtifact(BaseModel):
    model_config = ConfigDict(frozen=True)

    ingestion_job_id: str = Field(min_length=1)
    idempotency_key: str = Field(min_length=1)

    knowledge_release_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)

    knowledge_document_id: str = Field(min_length=1)
    source_document_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)

    title: str = Field(min_length=1)
    source_uri: str = Field(min_length=1)
    source_content_type: SourceContentType
    source_content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    classification: KnowledgeDocumentClassification
    locale: str = Field(min_length=1)
    effective_from: str | None = None
    effective_until: str | None = None

    parser_version: str = Field(min_length=1)
    chunking_strategy_version: str = Field(min_length=1)
    extraction_warnings: list[ExtractionWarning]
    chunks: list[ChunkDraft]

    artifact_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


def process_ingestion(request: IngestionRequest) -> IngestionArtifact:
    document = parse_source(
        request.source_path,
        source_uri=request.source_uri,
    )

    if document.source_content_type != request.expected_source_content_type:
        raise SourceContentTypeMismatchError(
            "Registered source content type does not match parsed source content type."
        )

    if (
        document.source_content_sha256.lower()
        != request.expected_source_content_sha256.lower()
    ):
        raise SourceContentHashMismatchError(
            "Registered source hash does not match the source file that was read."
        )

    chunks = chunk_document(document, request.chunking_config)

    artifact_fields = {
        "ingestion_job_id": request.ingestion_job_id,
        "idempotency_key": request.idempotency_key,
        "knowledge_release_id": request.knowledge_release_id,
        "tenant_id": request.tenant_id,
        "environment_id": request.environment_id,
        "knowledge_document_id": request.knowledge_document_id,
        "source_document_id": request.source_document_id,
        "source_version": request.source_version,
        "title": document.title,
        "source_uri": document.source_uri,
        "source_content_type": document.source_content_type,
        "source_content_sha256": document.source_content_sha256,
        "classification": request.classification,
        "locale": request.locale,
        "effective_from": request.effective_from,
        "effective_until": request.effective_until,
        "parser_version": document.parser_version,
        "chunking_strategy_version": (
            request.chunking_config.chunking_strategy_version
        ),
        "extraction_warnings": document.extraction_warnings,
        "chunks": chunks,
    }

    return IngestionArtifact(
        **artifact_fields,
        artifact_sha256=_artifact_sha256(artifact_fields),
    )


def _artifact_sha256(artifact_fields: dict[str, object]) -> str:
    canonical_json = json.dumps(
        artifact_fields,
        default=_json_default,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def _json_default(value: object) -> object:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")

    if isinstance(value, StrEnum):
        return value.value

    raise TypeError(f"Cannot serialize {type(value).__name__} into an artifact.")