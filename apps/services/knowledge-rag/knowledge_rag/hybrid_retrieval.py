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

    index_document_id: str = Field(min_length=1)
    rank: int = Field(gt=0)


class FusedCandidate(BaseModel):
    model_config = ConfigDict(frozen=True)

    index_document_id: str = Field(min_length=1)
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

        seen_index_document_ids: set[str] = set()

        for candidate in candidates:
            if candidate.index_document_id in seen_index_document_ids:
                raise ValueError(
                    f"Retriever '{retriever_name}' returned duplicate index "
                    f"document ID '{candidate.index_document_id}'."
                )

            seen_index_document_ids.add(candidate.index_document_id)
            fused_scores[candidate.index_document_id] += 1 / (
                rank_constant + candidate.rank
            )
            contributing_retrievers[candidate.index_document_id].append(
                retriever_name
            )

    fused_candidates = [
        FusedCandidate(
            index_document_id=index_document_id,
            reciprocal_rank_fusion_score=score,
            contributing_retrievers=(
                contributing_retrievers[index_document_id]
            ),
        )
        for index_document_id, score in fused_scores.items()
    ]

    return sorted(
        fused_candidates,
        key=lambda candidate: (
            -candidate.reciprocal_rank_fusion_score,
            candidate.index_document_id,
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

    evidence_by_index_document_id = _merge_evidence_by_index_document_id(
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
            evidence=(
                evidence_by_index_document_id[candidate.index_document_id]
            ),
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
            index_document_id=evidence.index_document_id,
            rank=rank,
        )
        for rank, evidence in enumerate(evidence_list, start=1)
    ]


def _merge_evidence_by_index_document_id(
    evidence_by_retriever: dict[str, Sequence[RetrievedEvidence]],
) -> dict[str, RetrievedEvidence]:
    merged_evidence: dict[str, RetrievedEvidence] = {}

    for retriever_name, evidence_list in evidence_by_retriever.items():
        for evidence in evidence_list:
            existing_evidence = merged_evidence.get(evidence.index_document_id)

            if (
                existing_evidence is not None
                and existing_evidence.content_sha256.lower()
                != evidence.content_sha256.lower()
            ):
                raise HybridRetrievalError(
                    f"Retriever '{retriever_name}' returned index document "
                    f"'{evidence.index_document_id}' with different content."
                )

            merged_evidence[evidence.index_document_id] = evidence

    return merged_evidence
