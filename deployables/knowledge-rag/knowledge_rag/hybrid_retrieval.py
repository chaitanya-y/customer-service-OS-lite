from collections import defaultdict
from collections.abc import Mapping, Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .retrieval_results import (
    RetrievedEvidence,
    to_retrieved_evidence_list,
)


class RankedCandidate(BaseModel):
    model_config = ConfigDict(frozen=True)

    chunk_id: str = Field(min_length=1)
    rank: int = Field(gt=0)


class FusedCandidate(BaseModel):
    model_config = ConfigDict(frozen=True)

    chunk_id: str = Field(min_length=1)
    reciprocal_rank_fusion_score: float
    contributing_retrievers: list[str] = Field(min_length=1)


def reciprocal_rank_fusion(
    ranked_candidates_by_retriever: dict[str, Sequence[RankedCandidate]],
    *,
    rank_constant: int = 60,
    top_k: int = 20,
) -> list[FusedCandidate]:
    if rank_constant <= 0:
        raise ValueError("rank_constant must be positive")

    if top_k <= 0:
        raise ValueError("top_k must be positive")

    fused_scores: defaultdict[str, float] = defaultdict(float)
    contributing_retrievers: defaultdict[str, list[str]] = defaultdict(list)

    for retriever_name, candidates in ranked_candidates_by_retriever.items():
        if not retriever_name.strip():
            raise ValueError("Retriever names must be non-empty")

        seen_chunk_ids: set[str] = set()

        for candidate in candidates:
            if candidate.chunk_id in seen_chunk_ids:
                raise ValueError(
                    f"Retriever '{retriever_name}' returned duplicate chunk "
                    f"ID '{candidate.chunk_id}'."
                )

            seen_chunk_ids.add(candidate.chunk_id)
            fused_scores[candidate.chunk_id] += 1 / (
                rank_constant + candidate.rank
            )
            contributing_retrievers[candidate.chunk_id].append(
                retriever_name
            )

    fused_candidates = [
        FusedCandidate(
            chunk_id=chunk_id,
            reciprocal_rank_fusion_score=score,
            contributing_retrievers=contributing_retrievers[chunk_id],
        )
        for chunk_id, score in fused_scores.items()
    ]

    return sorted(
        fused_candidates,
        key=lambda candidate: (
            -candidate.reciprocal_rank_fusion_score,
            candidate.chunk_id,
        ),
    )[:top_k]

class HybridRetrievalError(ValueError):
    """Raised when vector and keyword results cannot safely be combined."""


class FusedEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    evidence: RetrievedEvidence
    reciprocal_rank_fusion_score: float
    contributing_retrievers: list[str] = Field(min_length=1)


def fuse_retrieval_responses(
    *,
    vector_response: Mapping[str, Any],
    keyword_response: Mapping[str, Any],
    top_k: int = 20,
) -> list[FusedEvidence]:
    vector_evidence = to_retrieved_evidence_list(vector_response)
    keyword_evidence = to_retrieved_evidence_list(keyword_response)

    evidence_by_chunk_id = _merge_evidence_by_chunk_id(
        {
            "semantic_vector": vector_evidence,
            "lexical_keyword": keyword_evidence,
        }
    )

    fused_candidates = reciprocal_rank_fusion(
        {
            "semantic_vector": _to_ranked_candidates(vector_evidence),
            "lexical_keyword": _to_ranked_candidates(keyword_evidence),
        },
        top_k=top_k,
    )

    return [
        FusedEvidence(
            evidence=evidence_by_chunk_id[candidate.chunk_id],
            reciprocal_rank_fusion_score=(
                candidate.reciprocal_rank_fusion_score
            ),
            contributing_retrievers=candidate.contributing_retrievers,
        )
        for candidate in fused_candidates
    ]


def _to_ranked_candidates(
    evidence_list: Sequence[RetrievedEvidence],
) -> list[RankedCandidate]:
    return [
        RankedCandidate(
            chunk_id=evidence.chunk_id,
            rank=rank,
        )
        for rank, evidence in enumerate(evidence_list, start=1)
    ]


def _merge_evidence_by_chunk_id(
    evidence_by_retriever: dict[str, Sequence[RetrievedEvidence]],
) -> dict[str, RetrievedEvidence]:
    merged_evidence: dict[str, RetrievedEvidence] = {}

    for retriever_name, evidence_list in evidence_by_retriever.items():
        for evidence in evidence_list:
            existing_evidence = merged_evidence.get(evidence.chunk_id)

            if (
                existing_evidence is not None
                and existing_evidence.content_sha256.lower()
                != evidence.content_sha256.lower()
            ):
                raise HybridRetrievalError(
                    f"Retriever '{retriever_name}' returned chunk "
                    f"'{evidence.chunk_id}' with different content."
                )

            merged_evidence[evidence.chunk_id] = evidence

    return merged_evidence