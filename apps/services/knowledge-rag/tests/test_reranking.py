import sys
from types import ModuleType

import pytest

from knowledge_rag.hybrid_retrieval import FusedEvidence
from knowledge_rag.reranking import (
    DeterministicRerankingProvider,
    RerankerModel,
    RerankingProviderContractError,
    SentenceTransformersCrossEncoderProvider,
    rerank_fused_evidence,
)
from knowledge_rag.retrieval_results import (
    EvidenceCitation,
    RetrievedEvidence,
)


def make_fused_evidence(
    *,
    chunk_id: str,
    content: str,
    rrf_score: float,
) -> FusedEvidence:
    return FusedEvidence(
        evidence=RetrievedEvidence(
            index_document_id=f"index-{chunk_id}",
            knowledge_document_id="refund-policy-current-2026-08-01",
            chunk_id=chunk_id,
            content=content,
            content_sha256="a" * 64,
            retrieval_score=1.0,
            knowledge_release_id="refund-policy-2026-08-01",
            tenant_id="acme",
            environment_id="local",
            classification="CUSTOMER_SAFE",
            locale="en-US",
            citation=EvidenceCitation(
                source_uri="s3://cso-knowledge/acme/refund-policy.md",
                title="Acme Refund Policy",
                section_path=["Acme Refund Policy", chunk_id],
            ),
        ),
        reciprocal_rank_fusion_score=rrf_score,
        contributing_retrievers=["semantic_vector"],
    )


def test_rerank_fused_evidence_reorders_by_relevance() -> None:
    candidates = [
        make_fused_evidence(
            chunk_id="damaged-items",
            content="Damaged items need photo evidence.",
            rrf_score=0.04,
        ),
        make_fused_evidence(
            chunk_id="change-of-mind",
            content="Change-of-mind returns are allowed within fourteen days.",
            rrf_score=0.03,
        ),
    ]

    results = rerank_fused_evidence(
        query_text="Can I make a change-of-mind return?",
        candidates=candidates,
        provider=DeterministicRerankingProvider(),
    )

    assert [result.fused_evidence.evidence.chunk_id for result in results] == [
        "change-of-mind",
        "damaged-items",
    ]
    assert results[0].reranker_rank == 1
    assert results[0].reranker_model.provider == "deterministic"


def test_rerank_fused_evidence_uses_rrf_score_as_a_tie_breaker() -> None:
    candidates = [
        make_fused_evidence(
            chunk_id="lower-rrf",
            content="Refund policy.",
            rrf_score=0.02,
        ),
        make_fused_evidence(
            chunk_id="higher-rrf",
            content="Refund policy.",
            rrf_score=0.04,
        ),
    ]

    results = rerank_fused_evidence(
        query_text="Refund policy",
        candidates=candidates,
        provider=DeterministicRerankingProvider(),
    )

    assert [result.fused_evidence.evidence.chunk_id for result in results] == [
        "higher-rrf",
        "lower-rrf",
    ]


def test_rerank_fused_evidence_rejects_wrong_score_count() -> None:
    class WrongCountProvider:
        model = RerankerModel(
            provider="test",
            model_name="wrong-count",
            model_version="v1",
        )

        def score_documents(
            self,
            *,
            query_text: str,
            documents: list[str],
        ) -> list[float]:
            return []

    with pytest.raises(
        RerankingProviderContractError,
        match="one score for every candidate",
    ):
        rerank_fused_evidence(
            query_text="Can I get a refund?",
            candidates=[
                make_fused_evidence(
                    chunk_id="damaged-items",
                    content="Damaged items are refundable.",
                    rrf_score=0.04,
                )
            ],
            provider=WrongCountProvider(),
        )


def test_rerank_fused_evidence_returns_no_results_for_no_candidates() -> None:
    results = rerank_fused_evidence(
        query_text="Can I get a refund?",
        candidates=[],
        provider=DeterministicRerankingProvider(),
    )

    assert results == []

def test_cross_encoder_provider_rejects_invalid_max_length() -> None:
    with pytest.raises(ValueError, match="max_length must be greater than zero"):
        SentenceTransformersCrossEncoderProvider(max_length=0)


def test_cross_encoder_provider_scores_query_document_pairs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeCrossEncoder:
        received_pairs: list[tuple[str, str]]
        received_show_progress_bar: bool

        def __init__(
            self,
            model_name: str,
            *,
            revision: str,
            max_length: int,
        ) -> None:
            assert model_name == "test-cross-encoder"
            assert revision == "test-revision"
            assert max_length == 256

        def predict(
            self,
            pairs: list[tuple[str, str]],
            *,
            show_progress_bar: bool,
        ) -> list[float]:
            self.received_pairs = pairs
            self.received_show_progress_bar = show_progress_bar
            return [0.9, 0.2]

    fake_module = ModuleType("sentence_transformers")
    fake_module.CrossEncoder = FakeCrossEncoder
    monkeypatch.setitem(sys.modules, "sentence_transformers", fake_module)

    provider = SentenceTransformersCrossEncoderProvider(
        model_name="test-cross-encoder",
        model_revision="test-revision",
        max_length=256,
    )

    scores = provider.score_documents(
        "Can I refund a damaged item?",
        ["Damaged items are eligible.", "Shipping is free."],
    )

    assert scores == [0.9, 0.2]
    assert provider.model.provider == "sentence-transformers"
    assert provider._cross_encoder.received_pairs == [
        ("Can I refund a damaged item?", "Damaged items are eligible."),
        ("Can I refund a damaged item?", "Shipping is free."),
    ]
    assert provider._cross_encoder.received_show_progress_bar is False
