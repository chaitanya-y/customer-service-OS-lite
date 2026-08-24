import hashlib
from pathlib import Path

import pytest

from knowledge_rag.ingestion import (
    IngestionRequest,
    KnowledgeDocumentClassification,
    SourceContentHashMismatchError,
    SourceContentTypeMismatchError,
    process_ingestion,
)
from knowledge_rag.models import SourceContentType

SOURCE_PATH = (
    Path(__file__).parents[2]
    / "control-knowledge"
    / "fixtures"
    / "source-documents"
    / "acme"
    / "refund-policy-2026-08-01.md"
)


def make_request() -> IngestionRequest:
    return IngestionRequest(
        ingestion_job_id="ingestion-001",
        idempotency_key="acme-refund-policy-2026-08-01",
        knowledge_release_id="refund-policy-2026-08-01",
        tenant_id="acme",
        environment_id="local",
        knowledge_document_id="knowledge-document-001",
        source_document_id="refund-policy",
        source_version="2026-08-01",
        classification=KnowledgeDocumentClassification.CUSTOMER_SAFE,
        locale="en-US",
        effective_from="2026-08-01T00:00:00Z",
        source_path=SOURCE_PATH,
        source_uri=(
            "s3://cso-knowledge/acme/refund-policy-2026-08-01.md"
        ),
        expected_source_content_type=SourceContentType.MARKDOWN,
        expected_source_content_sha256=hashlib.sha256(
            SOURCE_PATH.read_bytes()
        ).hexdigest(),
    )


def test_process_ingestion_creates_governed_artifact() -> None:
    artifact = process_ingestion(make_request())

    assert artifact.ingestion_job_id == "ingestion-001"
    assert artifact.knowledge_release_id == "refund-policy-2026-08-01"
    assert artifact.tenant_id == "acme"
    assert artifact.classification == "CUSTOMER_SAFE"
    assert artifact.source_content_type == SourceContentType.MARKDOWN
    assert artifact.parser_version == "parser-v1"
    assert artifact.chunking_strategy_version == (
        "structure-aware-parent-child-v1"
    )
    assert artifact.chunks
    assert len(artifact.artifact_sha256) == 64


def test_process_ingestion_is_deterministic() -> None:
    first_artifact = process_ingestion(make_request())
    second_artifact = process_ingestion(make_request())

    assert first_artifact.artifact_sha256 == second_artifact.artifact_sha256
    assert first_artifact.chunks == second_artifact.chunks


def test_process_ingestion_rejects_changed_source_content() -> None:
    request = make_request().model_copy(
        update={"expected_source_content_sha256": "0" * 64}
    )

    with pytest.raises(
        SourceContentHashMismatchError,
        match="Registered source hash does not match",
    ):
        process_ingestion(request)


def test_process_ingestion_rejects_wrong_registered_content_type() -> None:
    request = make_request().model_copy(
        update={"expected_source_content_type": SourceContentType.DOCX}
    )

    with pytest.raises(
        SourceContentTypeMismatchError,
        match="Registered source content type does not match",
    ):
        process_ingestion(request)