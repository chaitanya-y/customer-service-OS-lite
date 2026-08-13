from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)

from .embeddings import EmbeddingModel
from .ingestion import KnowledgeDocumentClassification
from .opensearch_retrieval import RetrievalRequest
from .reranking import RerankedEvidence


class EvidenceReference(BaseModel):
    """The stable, document-scoped identity of one knowledge chunk."""

    model_config = ConfigDict(frozen=True)

    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)

    @property
    def key(self) -> tuple[str, str]:
        return (self.knowledge_document_id, self.chunk_id)


class RetrievalEvaluationCase(BaseModel):
    """
    One reviewed retrieval expectation.

    Evaluation data must contain synthetic or approved policy questions, never
    raw customer conversations.
    """

    model_config = ConfigDict(frozen=True)

    evaluation_case_id: str = Field(min_length=1)
    query_text: str = Field(min_length=1)

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    allowed_classifications: list[KnowledgeDocumentClassification] = Field(
        min_length=1
    )
    locale: str = Field(min_length=1)
    as_of: datetime

    expected_evidence: list[EvidenceReference] = Field(min_length=1)
    forbidden_evidence: list[EvidenceReference] = Field(
        default_factory=list
    )

    @model_validator(mode="after")
    def validate_expectations(self) -> RetrievalEvaluationCase:
        if self.as_of.tzinfo is None:
            raise ValueError("as_of must include a timezone")

        expected_evidence_keys = [
            reference.key for reference in self.expected_evidence
        ]
        forbidden_evidence_keys = [
            reference.key for reference in self.forbidden_evidence
        ]

        if len(set(expected_evidence_keys)) != len(expected_evidence_keys):
            raise ValueError("expected_evidence must not contain duplicates")

        if len(set(forbidden_evidence_keys)) != len(
            forbidden_evidence_keys
        ):
            raise ValueError("forbidden_evidence must not contain duplicates")

        if set(expected_evidence_keys).intersection(forbidden_evidence_keys):
            raise ValueError(
                "Evidence cannot be both expected and forbidden."
            )

        return self

    def to_retrieval_request(
        self,
        *,
        embedding_model: EmbeddingModel,
        top_k: int,
    ) -> RetrievalRequest:
        return RetrievalRequest(
            query_text=self.query_text,
            tenant_id=self.tenant_id,
            environment_id=self.environment_id,
            knowledge_release_id=self.knowledge_release_id,
            allowed_classifications=self.allowed_classifications,
            locale=self.locale,
            as_of=self.as_of,
            embedding_model=embedding_model,
            top_k=top_k,
        )


class RetrievalEvaluationError(ValueError):
    """Raised when retrieval results cannot be evaluated safely."""


class RetrievalEvaluationDataset(BaseModel):
    """A versioned set of reviewed retrieval evaluation cases."""

    model_config = ConfigDict(frozen=True)

    dataset_id: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    cases: list[RetrievalEvaluationCase] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_cases(self) -> RetrievalEvaluationDataset:
        evaluation_case_ids = [
            case.evaluation_case_id for case in self.cases
        ]

        if len(set(evaluation_case_ids)) != len(evaluation_case_ids):
            raise ValueError(
                "Evaluation datasets must not contain duplicate case IDs."
            )

        if any(
            case.knowledge_release_id != self.knowledge_release_id
            for case in self.cases
        ):
            raise ValueError(
                "Every evaluation case must match the dataset knowledge release."
            )

        return self


def load_retrieval_evaluation_dataset(
    path: Path,
) -> RetrievalEvaluationDataset:
    try:
        contents = path.read_text(encoding="utf-8")
    except OSError as error:
        raise RetrievalEvaluationError(
            f"Could not read evaluation dataset: {path}"
        ) from error

    try:
        return RetrievalEvaluationDataset.model_validate_json(contents)
    except ValidationError as error:
        raise RetrievalEvaluationError(
            f"Evaluation dataset is invalid: {path}"
        ) from error


class RetrievalCaseMetrics(BaseModel):
    """Metrics for one retrieval evaluation case."""

    model_config = ConfigDict(frozen=True)

    evaluation_case_id: str
    evaluated_k: int = Field(ge=0)
    expected_evidence_count: int = Field(gt=0)
    matched_evidence: list[EvidenceReference]
    retrieved_forbidden_evidence: list[EvidenceReference]
    recall_at_k: float = Field(ge=0, le=1)
    reciprocal_rank: float = Field(ge=0, le=1)

    @property
    def has_forbidden_evidence(self) -> bool:
        return bool(self.retrieved_forbidden_evidence)


def evaluate_retrieval_case(
    *,
    case: RetrievalEvaluationCase,
    evidence: Sequence[RerankedEvidence],
) -> RetrievalCaseMetrics:
    retrieved_evidence = [
        EvidenceReference(
            knowledge_document_id=(
                item.fused_evidence.evidence.knowledge_document_id
            ),
            chunk_id=item.fused_evidence.evidence.chunk_id,
        )
        for item in evidence
    ]
    retrieved_evidence_keys = [reference.key for reference in retrieved_evidence]

    if len(set(retrieved_evidence_keys)) != len(retrieved_evidence_keys):
        raise RetrievalEvaluationError(
            "Retrieved evidence must not contain duplicate document-scoped "
            "references."
        )

    expected_evidence_keys = {
        reference.key for reference in case.expected_evidence
    }
    matched_evidence = [
        reference
        for reference in retrieved_evidence
        if reference.key in expected_evidence_keys
    ]
    forbidden_evidence_keys = {
        reference.key for reference in case.forbidden_evidence
    }
    retrieved_forbidden_evidence = [
        reference
        for reference in retrieved_evidence
        if reference.key in forbidden_evidence_keys
    ]

    first_expected_rank = next(
        (
            rank
            for rank, reference in enumerate(retrieved_evidence, start=1)
            if reference.key in expected_evidence_keys
        ),
        None,
    )

    return RetrievalCaseMetrics(
        evaluation_case_id=case.evaluation_case_id,
        evaluated_k=len(retrieved_evidence),
        expected_evidence_count=len(expected_evidence_keys),
        matched_evidence=matched_evidence,
        recall_at_k=(
            len(matched_evidence) / len(expected_evidence_keys)
        ),
        reciprocal_rank=(
            0 if first_expected_rank is None else 1 / first_expected_rank
        ),
        retrieved_forbidden_evidence=retrieved_forbidden_evidence,
    )



class RetrievalEvaluationSummary(BaseModel):
    """Aggregate retrieval quality and safety across an evaluation dataset."""

    model_config = ConfigDict(frozen=True)

    case_count: int = Field(gt=0)
    mean_recall: float = Field(ge=0, le=1)
    mean_reciprocal_rank: float = Field(ge=0, le=1)
    cases_with_forbidden_evidence: int = Field(ge=0)
    forbidden_evidence_rate: float = Field(ge=0, le=1)


def summarize_retrieval_metrics(
    metrics: Sequence[RetrievalCaseMetrics],
) -> RetrievalEvaluationSummary:
    if not metrics:
        raise RetrievalEvaluationError(
            "Cannot summarize an empty evaluation dataset."
        )

    evaluation_case_ids = [
        metric.evaluation_case_id for metric in metrics
    ]
    if len(set(evaluation_case_ids)) != len(evaluation_case_ids):
        raise RetrievalEvaluationError(
            "Evaluation metrics must contain unique evaluation case IDs."
        )

    cases_with_forbidden_evidence = sum(
        metric.has_forbidden_evidence for metric in metrics
    )

    return RetrievalEvaluationSummary(
        case_count=len(metrics),
        mean_recall=sum(metric.recall_at_k for metric in metrics)
        / len(metrics),
        mean_reciprocal_rank=sum(
            metric.reciprocal_rank for metric in metrics
        )
        / len(metrics),
        cases_with_forbidden_evidence=cases_with_forbidden_evidence,
        forbidden_evidence_rate=(
            cases_with_forbidden_evidence / len(metrics)
        ),
    )
