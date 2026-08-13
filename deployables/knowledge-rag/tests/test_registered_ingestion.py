from pathlib import Path

import pytest

from knowledge_rag.ingestion import (
    KnowledgeDocumentClassification,
    SourceContentHashMismatchError,
)
from knowledge_rag.registered_ingestion import (
    RegisteredIngestionError,
    build_registered_ingestion_request,
    ingest_registered_source,
)
from knowledge_rag.source_registry import (
    load_knowledge_release_manifest,
)

FIXTURES_PATH = Path(__file__).resolve().parents[1] / "fixtures"

MANIFEST_PATH = (
    FIXTURES_PATH
    / "source-registrations"
    / "acme"
    / "refund-knowledge-release-v1.json"
)

INTERNAL_PLAYBOOK_URI = (
    "s3://cso-knowledge/acme/internal-refund-escalation-playbook.md"
)

INTERNAL_PLAYBOOK_PATH = (
    FIXTURES_PATH
    / "source-documents"
    / "acme"
    / "internal-refund-escalation-playbook.md"
)


class FakeSourceUriResolver:
    def __init__(self, paths_by_uri: dict[str, Path]) -> None:
        self._paths_by_uri = paths_by_uri
        self.resolved_uris: list[str] = []

    def resolve(self, source_uri: str) -> Path:
        self.resolved_uris.append(source_uri)
        return self._paths_by_uri[source_uri]


def test_registered_ingestion_uses_manifest_metadata() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)
    resolver = FakeSourceUriResolver(
        {INTERNAL_PLAYBOOK_URI: INTERNAL_PLAYBOOK_PATH}
    )

    request = build_registered_ingestion_request(
        manifest=manifest,
        knowledge_document_id=(
            "internal-refund-escalation-playbook-2026-08-01"
        ),
        source_uri_resolver=resolver,
        ingestion_job_id="ingestion-001",
        idempotency_key="internal-playbook-v1",
    )

    assert request.tenant_id == "acme"
    assert request.knowledge_release_id == "refund-policy-2026-08-01"
    assert request.classification == (
        KnowledgeDocumentClassification.INTERNAL
    )
    assert request.source_path == INTERNAL_PLAYBOOK_PATH
    assert request.source_uri == INTERNAL_PLAYBOOK_URI
    assert request.expected_source_content_sha256 == (
        "aa90d1d38d3b90fda70a9e7d14ed85aa5593b38f6da13f80"
        "a344e985171b4848"
    )
    assert resolver.resolved_uris == [INTERNAL_PLAYBOOK_URI]


def test_registered_ingestion_rejects_an_unregistered_document() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)

    with pytest.raises(
        RegisteredIngestionError,
        match="not registered in this knowledge release",
    ):
        build_registered_ingestion_request(
            manifest=manifest,
            knowledge_document_id="made-up-policy",
            source_uri_resolver=FakeSourceUriResolver({}),
            ingestion_job_id="ingestion-001",
            idempotency_key="made-up-policy-v1",
        )


def test_registered_ingestion_uses_the_manifest_effective_dates() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)
    superseded_policy_uri = (
        "s3://cso-knowledge/acme/refund-policy-2026-07-01.md"
    )
    resolver = FakeSourceUriResolver(
        {
            superseded_policy_uri: (
                FIXTURES_PATH
                / "source-documents"
                / "acme"
                / "refund-policy-superseded-2026-07-01.md"
            )
        }
    )

    request = build_registered_ingestion_request(
        manifest=manifest,
        knowledge_document_id="refund-policy-superseded-2026-07-01",
        source_uri_resolver=resolver,
        ingestion_job_id="ingestion-002",
        idempotency_key="superseded-policy-v1",
    )

    assert request.classification == (
        KnowledgeDocumentClassification.CUSTOMER_SAFE
    )
    assert request.effective_from == "2026-07-01T00:00:00+00:00"
    assert request.effective_until == "2026-08-01T00:00:00+00:00"


def test_ingest_registered_source_creates_a_governed_artifact() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)

    artifact = ingest_registered_source(
        manifest=manifest,
        knowledge_document_id=(
            "internal-refund-escalation-playbook-2026-08-01"
        ),
        source_uri_resolver=FakeSourceUriResolver(
            {INTERNAL_PLAYBOOK_URI: INTERNAL_PLAYBOOK_PATH}
        ),
        ingestion_job_id="ingestion-003",
        idempotency_key="internal-playbook-v1",
    )

    assert artifact.classification == KnowledgeDocumentClassification.INTERNAL
    assert artifact.source_content_sha256 == (
        "aa90d1d38d3b90fda70a9e7d14ed85aa5593b38f6da13f80"
        "a344e985171b4848"
    )
    assert artifact.effective_from == "2026-08-01T00:00:00+00:00"
    assert artifact.chunks


def test_ingest_registered_source_rejects_changed_source_content() -> None:
    manifest = load_knowledge_release_manifest(MANIFEST_PATH)
    internal_registration = manifest.registrations[1].model_copy(
        update={"expected_source_content_sha256": "0" * 64}
    )
    changed_manifest = manifest.model_copy(
        update={
            "registrations": [
                manifest.registrations[0],
                internal_registration,
                manifest.registrations[2],
            ]
        }
    )

    with pytest.raises(
        SourceContentHashMismatchError,
        match="Registered source hash does not match",
    ):
        ingest_registered_source(
            manifest=changed_manifest,
            knowledge_document_id=(
                "internal-refund-escalation-playbook-2026-08-01"
            ),
            source_uri_resolver=FakeSourceUriResolver(
                {INTERNAL_PLAYBOOK_URI: INTERNAL_PLAYBOOK_PATH}
            ),
            ingestion_job_id="ingestion-004",
            idempotency_key="changed-internal-playbook-v1",
        )
