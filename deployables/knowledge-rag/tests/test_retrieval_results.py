import pytest

from knowledge_rag.retrieval_results import (
    RetrievalResponseError,
    to_retrieved_evidence,
    to_retrieved_evidence_list,
)


def make_hit(*, page_start: int | None = None) -> dict[str, object]:
    return {
        "_score": 1.6037,
        "_source": {
            "index_document_id": "knowledge-001",
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-002-chunk-001",
            "content": (
                "Customers may request a refund within thirty calendar days."
            ),
            "content_sha256": "a" * 64,
            "knowledge_release_id": "refund-policy-2026-08-01",
            "tenant_id": "acme",
            "environment_id": "local",
            "classification": "CUSTOMER_SAFE",
            "locale": "en-US",
            "source_uri": (
                "s3://cso-knowledge/acme/refund-policy-2026-08-01.md"
            ),
            "title": "Acme Refund Policy",
            "section_path": [
                "Acme Refund Policy",
                "2. Refund eligibility",
            ],
            "page_start": page_start,
            "page_end": page_start,
        },
    }


def test_to_retrieved_evidence_preserves_citation_and_score() -> None:
    evidence = to_retrieved_evidence(make_hit())

    assert evidence.chunk_id == "section-002-chunk-001"
    assert evidence.knowledge_document_id == "refund-policy-current-2026-08-01"
    assert evidence.retrieval_score == 1.6037
    assert evidence.citation.display_location() == (
        "Acme Refund Policy > 2. Refund eligibility"
    )


def test_citation_includes_pdf_page_when_available() -> None:
    evidence = to_retrieved_evidence(make_hit(page_start=2))

    assert evidence.citation.display_location() == (
        "Acme Refund Policy > 2. Refund eligibility, page 2"
    )


def test_to_retrieved_evidence_list_converts_all_hits() -> None:
    evidence_list = to_retrieved_evidence_list(
        {
            "hits": {
                "hits": [
                    make_hit(),
                    make_hit(page_start=2),
                ]
            }
        }
    )

    assert len(evidence_list) == 2
    assert evidence_list[1].citation.page_start == 2


def test_to_retrieved_evidence_rejects_missing_evidence_content() -> None:
    hit = make_hit()
    hit["_source"]["content"] = ""

    with pytest.raises(
        RetrievalResponseError,
        match="content.*non-empty string",
    ):
        to_retrieved_evidence(hit)
