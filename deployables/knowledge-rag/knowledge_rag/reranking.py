from __future__ import annotations

import math
import re
from collections.abc import Sequence
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from .hybrid_retrieval import FusedEvidence

WORD_PATTERN = re.compile(r"\b[\w-]+\b")


class RerankingProviderContractError(ValueError):
    """Raised when a reranking provider violates its interface contract."""


class RerankerModel(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str = Field(min_length=1)
    model_name: str = Field(min_length=1)
    model_version: str = Field(min_length=1)


class RerankedEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    fused_evidence: FusedEvidence
    reranker_score: float
    reranker_rank: int = Field(gt=0)
    reranker_model: RerankerModel


class RerankingProvider(Protocol):
    model: RerankerModel

    def score_documents(
        self,
        *,
        query_text: str,
        documents: Sequence[str],
    ) -> list[float]:
        """Return one relevance score for every document, in the same order."""


class DeterministicRerankingProvider:
    """
    Test-only provider.

    It scores a document by query-word overlap. It is not a semantic reranker and
    must never be used in the customer-answer path.
    """

    def __init__(self) -> None:
        self.model = RerankerModel(
            provider="deterministic",
            model_name="token-overlap-test-reranker",
            model_version="v1",
        )

    def score_documents(
        self,
        *,
        query_text: str,
        documents: Sequence[str],
    ) -> list[float]:
        query_words = set(_words(query_text))

        return [
            float(len(query_words.intersection(_words(document))))
            for document in documents
        ]

DEFAULT_CROSS_ENCODER_MODEL = "cross-encoder/ms-marco-MiniLM-L6-v2"
DEFAULT_CROSS_ENCODER_REVISION = "d6042621b3ca5abbebc48a89fdc253730186930e"


class SentenceTransformersCrossEncoderProvider:
    """Runs a real cross-encoder reranker locally."""

    def __init__(
        self,
        model_name: str = DEFAULT_CROSS_ENCODER_MODEL,
        model_revision: str = DEFAULT_CROSS_ENCODER_REVISION,
        max_length: int = 512,
    ) -> None:
        if max_length <= 0:
            raise ValueError("max_length must be greater than zero")

        from sentence_transformers import CrossEncoder

        self.model = RerankerModel(
            provider="sentence-transformers",
            model_name=model_name,
            model_version=model_revision,
        )
        self._cross_encoder = CrossEncoder(
            model_name,
            revision=model_revision,
            max_length=max_length,
        )

    def score_documents(
        self,
        query_text: str,
        documents: Sequence[str],
    ) -> list[float]:
        if not query_text.strip():
            raise RerankingProviderContractError("query_text cannot be blank")

        pairs = [(query_text, document) for document in documents]
        scores = self._cross_encoder.predict(pairs, show_progress_bar=False)

        return [float(score) for score in scores]

def rerank_fused_evidence(
    *,
    query_text: str,
    candidates: Sequence[FusedEvidence],
    provider: RerankingProvider,
    top_k: int = 5,
) -> list[RerankedEvidence]:
    if not query_text.strip():
        raise ValueError("query_text must be non-empty")

    if top_k <= 0:
        raise ValueError("top_k must be positive")

    if not candidates:
        return []

    scores = provider.score_documents(
        query_text=query_text,
        documents=[candidate.evidence.content for candidate in candidates],
    )

    if len(scores) != len(candidates):
        raise RerankingProviderContractError(
            "Reranking provider must return one score for every candidate."
        )

    if not all(math.isfinite(score) for score in scores):
        raise RerankingProviderContractError(
            "Reranking provider scores must be finite."
        )

    scored_candidates = list(zip(candidates, scores, strict=True))

    ranked_candidates = sorted(
        scored_candidates,
        key=lambda item: (
            -item[1],
            -item[0].reciprocal_rank_fusion_score,
            item[0].evidence.chunk_id,
        ),
    )

    return [
        RerankedEvidence(
            fused_evidence=candidate,
            reranker_score=score,
            reranker_rank=rank,
            reranker_model=provider.model,
        )
        for rank, (candidate, score) in enumerate(
            ranked_candidates[:top_k],
            start=1,
        )
    ]


def _words(text: str) -> list[str]:
    return [
        word.lower()
        for word in WORD_PATTERN.findall(text)
    ]