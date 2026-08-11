import pytest

from knowledge_rag.chunking import ChunkingConfig, chunk_document
from knowledge_rag.models import (
    NormalizedDocument,
    NormalizedSection,
    SourceContentType,
)


def make_document(*sections: NormalizedSection) -> NormalizedDocument:
    return NormalizedDocument(
        source_uri="s3://cso-knowledge/acme/refund-policy.md",
        source_content_type=SourceContentType.MARKDOWN,
        source_content_sha256="a" * 64,
        title="ACME refund policy",
        sections=list(sections),
        parser_version="parser-v1",
    )


def test_chunk_document_preserves_section_provenance() -> None:
    document = make_document(
        NormalizedSection(
            section_id="refund-eligibility",
            heading="Refund eligibility",
            heading_path=["Refund policy", "Refund eligibility"],
            text="A refund request is eligible within thirty days of delivery.",
            page_start=2,
            page_end=2,
        )
    )

    chunks = chunk_document(document)

    assert len(chunks) == 1
    chunk = chunks[0]
    assert chunk.chunk_id == "refund-eligibility-chunk-001"
    assert chunk.parent_section_id == "refund-eligibility"
    assert chunk.section_path == ["Refund policy", "Refund eligibility"]
    assert chunk.page_start == 2
    assert chunk.page_end == 2
    assert chunk.source_uri == document.source_uri
    assert chunk.source_content_sha256 == document.source_content_sha256
    assert chunk.content_sha256


def test_chunk_document_never_combines_sections() -> None:
    document = make_document(
        NormalizedSection(
            section_id="refund-eligibility",
            heading="Refund eligibility",
            heading_path=["Refund policy", "Refund eligibility"],
            text="ELIGIBILITY_MARKER refunds are available within thirty days.",
        ),
        NormalizedSection(
            section_id="approval-limits",
            heading="Approval limits",
            heading_path=["Refund policy", "Approval limits"],
            text="APPROVAL_MARKER refunds above one hundred dollars need approval.",
        ),
    )

    chunks = chunk_document(document)

    eligibility_chunks = [
        chunk for chunk in chunks if chunk.parent_section_id == "refund-eligibility"
    ]
    approval_chunks = [
        chunk for chunk in chunks if chunk.parent_section_id == "approval-limits"
    ]

    assert len(eligibility_chunks) == 1
    assert len(approval_chunks) == 1
    assert "APPROVAL_MARKER" not in eligibility_chunks[0].content
    assert "ELIGIBILITY_MARKER" not in approval_chunks[0].content


def test_chunk_document_splits_long_sections_within_token_budget() -> None:
    document = make_document(
        NormalizedSection(
            section_id="refund-eligibility",
            heading="Refund eligibility",
            heading_path=["Refund policy", "Refund eligibility"],
            text="Refunds are available for eligible purchases. " * 20,
        )
    )
    config = ChunkingConfig(
        target_token_count=30,
        overlap_token_count=6,
    )

    chunks = chunk_document(document, config)

    assert len(chunks) > 1
    assert [chunk.chunk_ordinal_within_section for chunk in chunks] == list(
        range(1, len(chunks) + 1)
    )
    assert all(chunk.token_count <= config.target_token_count for chunk in chunks)
    assert all(
        chunk.parent_section_id == "refund-eligibility" for chunk in chunks
    )


def test_chunking_config_rejects_invalid_overlap() -> None:
    with pytest.raises(
        ValueError,
        match="overlap_token_count must be smaller than target_token_count",
    ):
        ChunkingConfig(
            target_token_count=30,
            overlap_token_count=30,
        )