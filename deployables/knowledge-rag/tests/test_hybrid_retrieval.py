import pytest

from knowledge_rag.hybrid_retrieval import (
    HybridRetrievalError,
    RankedCandidate,
    fuse_retrieval_responses,
    reciprocal_rank_fusion,
)


def test_reciprocal_rank_fusion_rewards_candidates_found_by_both() -> None:
    fused_candidates = reciprocal_rank_fusion(
        {
            "vector": [
                RankedCandidate(index_document_id="A", rank=1),
                RankedCandidate(index_document_id="B", rank=2),
            ],
            "keyword": [
                RankedCandidate(index_document_id="B", rank=1),
                RankedCandidate(index_document_id="D", rank=2),
            ],
        }
    )

    assert [candidate.index_document_id for candidate in fused_candidates] == [
        "B",
        "A",
        "D",
    ]
    assert fused_candidates[0].contributing_retrievers == [
        "vector",
        "keyword",
    ]


def test_reciprocal_rank_fusion_preserves_single_retriever_candidates() -> None:
    fused_candidates = reciprocal_rank_fusion(
        {
            "vector": [
                RankedCandidate(index_document_id="A", rank=1),
            ],
            "keyword": [
                RankedCandidate(index_document_id="B", rank=1),
            ],
        }
    )

    assert [candidate.index_document_id for candidate in fused_candidates] == [
        "A",
        "B",
    ]
    assert fused_candidates[0].contributing_retrievers == ["vector"]
    assert fused_candidates[1].contributing_retrievers == ["keyword"]


def test_reciprocal_rank_fusion_rejects_duplicate_index_document_from_one_retriever() -> None:
    with pytest.raises(ValueError, match="duplicate index document ID"):
        reciprocal_rank_fusion(
            {
                "vector": [
                    RankedCandidate(index_document_id="A", rank=1),
                    RankedCandidate(index_document_id="A", rank=2),
                ]
            }
        )


def test_reciprocal_rank_fusion_rejects_invalid_limits() -> None:
    with pytest.raises(ValueError, match="rank_constant must be positive"):
        reciprocal_rank_fusion({}, rank_constant=0)

    with pytest.raises(ValueError, match="top_k must be positive"):
        reciprocal_rank_fusion({}, top_k=0)

def make_hit(
    *,
    chunk_id: str,
    content: str,
    score: float,
    index_document_id: str | None = None,
    knowledge_document_id: str = "refund-policy-current-2026-08-01",
    content_sha256: str = "a" * 64,
) -> dict[str, object]:
    return {
        "_score": score,
        "_source": {
            "index_document_id": index_document_id or f"index-{chunk_id}",
            "knowledge_document_id": knowledge_document_id,
            "chunk_id": chunk_id,
            "content": content,
            "content_sha256": content_sha256,
            "knowledge_release_id": "refund-policy-2026-08-01",
            "tenant_id": "acme",
            "environment_id": "local",
            "classification": "CUSTOMER_SAFE",
            "locale": "en-US",
            "source_uri": "s3://cso-knowledge/acme/refund-policy.md",
            "title": "Acme Refund Policy",
            "section_path": ["Acme Refund Policy", chunk_id],
        },
    }


def test_fuse_retrieval_responses_rewards_evidence_found_by_both() -> None:
    fused_evidence = fuse_retrieval_responses(
        vector_response={
            "hits": {
                "hits": [
                    make_hit(
                        chunk_id="damaged-items",
                        content="Damaged items are refundable.",
                        score=0.9,
                    ),
                    make_hit(
                        chunk_id="missing-items",
                        content="Missing items are refundable.",
                        score=0.8,
                    ),
                ]
            }
        },
        keyword_response={
            "hits": {
                "hits": [
                    make_hit(
                        chunk_id="missing-items",
                        content="Missing items are refundable.",
                        score=12.0,
                    ),
                    make_hit(
                        chunk_id="final-sale",
                        content="Final-sale items are not refundable.",
                        score=10.0,
                    ),
                ]
            }
        },
    )

    assert [item.evidence.chunk_id for item in fused_evidence] == [
        "missing-items",
        "damaged-items",
        "final-sale",
    ]
    assert fused_evidence[0].contributing_retrievers == [
        "semantic_vector",
        "lexical_keyword",
    ]


def test_fuse_retrieval_responses_rejects_same_chunk_with_changed_content() -> None:
    with pytest.raises(HybridRetrievalError, match="different content"):
        fuse_retrieval_responses(
            vector_response={
                "hits": {
                    "hits": [
                        make_hit(
                            chunk_id="damaged-items",
                            content="Original text.",
                            score=0.9,
                        )
                    ]
                }
            },
            keyword_response={
                "hits": {
                    "hits": [
                        make_hit(
                            chunk_id="damaged-items",
                            content="Changed text.",
                            score=12.0,
                            content_sha256="b" * 64,
                        )
                    ]
                }
            },
        )


def test_fuse_retrieval_responses_keeps_same_local_chunk_from_two_documents() -> None:
    fused_evidence = fuse_retrieval_responses(
        vector_response={
            "hits": {
                "hits": [
                    make_hit(
                        chunk_id="section-001-chunk-001",
                        content="Customer refund policy introduction.",
                        score=0.9,
                        index_document_id="current-policy-section-001",
                    )
                ]
            }
        },
        keyword_response={
            "hits": {
                "hits": [
                    make_hit(
                        chunk_id="section-001-chunk-001",
                        content="Internal escalation playbook introduction.",
                        score=12.0,
                        index_document_id="internal-playbook-section-001",
                        knowledge_document_id=(
                            "internal-refund-escalation-playbook-2026-08-01"
                        ),
                        content_sha256="b" * 64,
                    )
                ]
            }
        },
    )

    assert [item.evidence.index_document_id for item in fused_evidence] == [
        "current-policy-section-001",
        "internal-playbook-section-001",
    ]
    assert [item.evidence.chunk_id for item in fused_evidence] == [
        "section-001-chunk-001",
        "section-001-chunk-001",
    ]
