import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.models import SourceContentType
from knowledge_rag.source_registry import (
    KnowledgeReleaseManifest,
    KnowledgeSourceManifestError,
    KnowledgeSourceRegistration,
    load_knowledge_release_manifest,
)

REAL_MANIFEST_PATH = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "source-registrations"
    / "acme"
    / "refund-knowledge-release-v1.json"
)


def make_registration(
    *,
    knowledge_document_id: str = "refund-policy-current",
    source_document_id: str = "refund-policy",
    source_version: str = "2026-08-01",
    effective_from: datetime | None = datetime(
        2026,
        8,
        1,
        tzinfo=UTC,
    ),
    effective_until: datetime | None = None,
) -> KnowledgeSourceRegistration:
    return KnowledgeSourceRegistration(
        knowledge_document_id=knowledge_document_id,
        source_document_id=source_document_id,
        source_version=source_version,
        source_uri="s3://cso-knowledge/acme/refund-policy.md",
        expected_source_content_type=SourceContentType.MARKDOWN,
        expected_source_content_sha256="a" * 64,
        classification=KnowledgeDocumentClassification.CUSTOMER_SAFE,
        locale="en-US",
        effective_from=effective_from,
        effective_until=effective_until,
    )


def test_manifest_preserves_trusted_access_and_temporal_metadata() -> None:
    internal_playbook = make_registration(
        knowledge_document_id="internal-refund-escalation-playbook",
        source_document_id="internal-refund-escalation-playbook",
        source_version="2026-08-01",
        effective_from=datetime(2026, 8, 1, tzinfo=UTC),
    ).model_copy(
        update={
            "classification": KnowledgeDocumentClassification.INTERNAL,
            "source_uri": (
                "s3://cso-knowledge/acme/"
                "internal-refund-escalation-playbook.md"
            ),
        }
    )
    superseded_policy = make_registration(
        knowledge_document_id="refund-policy-superseded",
        source_document_id="refund-policy",
        source_version="2026-07-01",
        effective_from=datetime(2026, 7, 1, tzinfo=UTC),
        effective_until=datetime(2026, 8, 1, tzinfo=UTC),
    )

    manifest = KnowledgeReleaseManifest(
        tenant_id="acme",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        registrations=[internal_playbook, superseded_policy],
    )

    assert manifest.registrations[0].classification == (
        KnowledgeDocumentClassification.INTERNAL
    )
    assert manifest.registrations[1].effective_until == datetime(
        2026,
        8,
        1,
        tzinfo=UTC,
    )


def test_registration_rejects_effective_dates_without_timezones() -> None:
    with pytest.raises(
        ValueError,
        match="effective_from must include a timezone",
    ):
        make_registration(
            effective_from=datetime(2026, 8, 1),  # noqa: DTZ001
        )


def test_registration_rejects_an_invalid_effective_date_range() -> None:
    with pytest.raises(
        ValueError,
        match="effective_until must be after effective_from",
    ):
        make_registration(
            effective_from=datetime(2026, 8, 1, tzinfo=UTC),
            effective_until=datetime(2026, 8, 1, tzinfo=UTC),
        )


def test_manifest_rejects_duplicate_knowledge_document_ids() -> None:
    first = make_registration()
    duplicate = make_registration(
        source_document_id="other-source",
        source_version="v2",
    )

    with pytest.raises(
        ValueError,
        match="duplicate knowledge_document_id",
    ):
        KnowledgeReleaseManifest(
            tenant_id="acme",
            environment_id="local",
            knowledge_release_id="refund-policy-2026-08-01",
            registrations=[first, duplicate],
        )


def test_manifest_rejects_duplicate_source_revisions() -> None:
    first = make_registration()
    duplicate = make_registration(
        knowledge_document_id="another-policy-document",
    )

    with pytest.raises(
        ValueError,
        match="duplicate source document revisions",
    ):
        KnowledgeReleaseManifest(
            tenant_id="acme",
            environment_id="local",
            knowledge_release_id="refund-policy-2026-08-01",
            registrations=[first, duplicate],
        )


def test_load_knowledge_release_manifest_loads_the_real_fixture() -> None:
    manifest = load_knowledge_release_manifest(REAL_MANIFEST_PATH)

    assert manifest.tenant_id == "acme"
    assert manifest.knowledge_release_id == "refund-policy-2026-08-01"
    assert len(manifest.registrations) == 3
    assert manifest.registrations[1].classification == (
        KnowledgeDocumentClassification.INTERNAL
    )
    assert manifest.registrations[2].effective_until == datetime(
        2026,
        8,
        1,
        tzinfo=UTC,
    )


def test_load_knowledge_release_manifest_rejects_invalid_json(
    tmp_path: Path,
) -> None:
    path = tmp_path / "invalid.json"
    path.write_text("{not valid json}", encoding="utf-8")

    with pytest.raises(
        KnowledgeSourceManifestError,
        match="Knowledge release manifest is invalid",
    ):
        load_knowledge_release_manifest(path)


def test_load_knowledge_release_manifest_rejects_duplicate_source_revision(
    tmp_path: Path,
) -> None:
    registration = make_registration().model_dump(mode="json")
    duplicate = {
        **registration,
        "knowledge_document_id": "another-knowledge-document",
    }
    path = tmp_path / "duplicate-source-revision.json"
    path.write_text(
        json.dumps(
            {
                "tenant_id": "acme",
                "environment_id": "local",
                "knowledge_release_id": "refund-policy-2026-08-01",
                "registrations": [registration, duplicate],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        KnowledgeSourceManifestError,
        match="Knowledge release manifest is invalid",
    ):
        load_knowledge_release_manifest(path)
