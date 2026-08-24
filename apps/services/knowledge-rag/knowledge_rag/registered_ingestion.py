from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .ingestion import (
    IngestionArtifact,
    IngestionRequest,
    process_ingestion,
)
from .source_registry import KnowledgeReleaseManifest


class RegisteredIngestionError(ValueError):
    """Raised when a source cannot safely become a registered ingestion request."""

class SourceUriResolver(Protocol):
    """Resolves an approved source URI to content available to the RAG service."""

    def resolve(self, source_uri: str) -> Path:
        """Return the local path of the source content for this ingestion run."""


def build_registered_ingestion_request(
    *,
    manifest: KnowledgeReleaseManifest,
    knowledge_document_id: str,
    source_uri_resolver: SourceUriResolver,
    ingestion_job_id: str,
    idempotency_key: str,
) -> IngestionRequest:
    registration = _find_registration(
        manifest=manifest,
        knowledge_document_id=knowledge_document_id,
    )

    return IngestionRequest(
        ingestion_job_id=ingestion_job_id,
        idempotency_key=idempotency_key,
        knowledge_release_id=manifest.knowledge_release_id,
        tenant_id=manifest.tenant_id,
        environment_id=manifest.environment_id,
        knowledge_document_id=registration.knowledge_document_id,
        source_document_id=registration.source_document_id,
        source_version=registration.source_version,
        classification=registration.classification,
        locale=registration.locale,
        effective_from=_format_timestamp(registration.effective_from),
        effective_until=_format_timestamp(registration.effective_until),
        source_path=source_uri_resolver.resolve(registration.source_uri),
        source_uri=registration.source_uri,
        expected_source_content_type=(
            registration.expected_source_content_type
        ),
        expected_source_content_sha256=(
            registration.expected_source_content_sha256
        ),
    )


def _find_registration(
    *,
    manifest: KnowledgeReleaseManifest,
    knowledge_document_id: str,
):
    for registration in manifest.registrations:
        if registration.knowledge_document_id == knowledge_document_id:
            return registration

    raise RegisteredIngestionError(
        "Knowledge document is not registered in this knowledge release: "
        f"{knowledge_document_id}"
    )


def _format_timestamp(timestamp):
    return None if timestamp is None else timestamp.isoformat()

def ingest_registered_source(
    *,
    manifest: KnowledgeReleaseManifest,
    knowledge_document_id: str,
    source_uri_resolver: SourceUriResolver,
    ingestion_job_id: str,
    idempotency_key: str,
) -> IngestionArtifact:
    request = build_registered_ingestion_request(
        manifest=manifest,
        knowledge_document_id=knowledge_document_id,
        source_uri_resolver=source_uri_resolver,
        ingestion_job_id=ingestion_job_id,
        idempotency_key=idempotency_key,
    )

    return process_ingestion(request)
