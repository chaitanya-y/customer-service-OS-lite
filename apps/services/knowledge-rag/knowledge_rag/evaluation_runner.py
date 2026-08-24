from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .embeddings import EmbeddingModel
from .evaluation import (
    RetrievalCaseMetrics,
    RetrievalEvaluationDataset,
    RetrievalEvaluationSummary,
    evaluate_retrieval_case,
    summarize_retrieval_metrics,
)
from .opensearch_retrieval import RetrievalRequest
from .reranking import RerankerModel
from .retrieval_service import RetrievalExecutionResult


class RetrievalEvaluationRunnerError(RuntimeError):
    """Raised when a retrieval evaluation run cannot complete safely."""


class RetrievalExecutor(Protocol):
    """The retrieval capability needed by the evaluation runner."""

    def retrieve(
        self,
        request: RetrievalRequest,
    ) -> RetrievalExecutionResult:
        """Return the evidence produced for one governed request."""


class RetrievalEvaluationRun(BaseModel):
    """A reproducible result for one full retrieval evaluation dataset run."""

    model_config = ConfigDict(frozen=True)

    dataset_id: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    top_k: int = Field(gt=0)

    embedding_model: EmbeddingModel
    reranker_model: RerankerModel

    case_metrics: list[RetrievalCaseMetrics] = Field(min_length=1)
    summary: RetrievalEvaluationSummary

    @model_validator(mode="after")
    def validate_summary(self) -> RetrievalEvaluationRun:
        if len(self.case_metrics) != self.summary.case_count:
            raise ValueError(
                "Evaluation summary case count must match case metrics."
            )

        return self

def run_retrieval_evaluation(
    *,
    dataset: RetrievalEvaluationDataset,
    executor: RetrievalExecutor,
    embedding_model: EmbeddingModel,
    top_k: int,
) -> RetrievalEvaluationRun:
    if top_k <= 0:
        raise ValueError("top_k must be positive")

    case_metrics: list[RetrievalCaseMetrics] = []
    reranker_model: RerankerModel | None = None

    for case in dataset.cases:
        request = case.to_retrieval_request(
            embedding_model=embedding_model,
            top_k=top_k,
        )
        result = executor.retrieve(request)

        _validate_execution_result(
            case=case,
            expected_request=request,
            result=result,
            embedding_model=embedding_model,
        )

        if reranker_model is None:
            reranker_model = result.reranker_model
        elif result.reranker_model != reranker_model:
            raise RetrievalEvaluationRunnerError(
                "One evaluation run cannot mix reranker models."
            )

        case_metrics.append(
            evaluate_retrieval_case(
                case=case,
                evidence=result.evidence,
            )
        )

    summary = summarize_retrieval_metrics(case_metrics)

    return RetrievalEvaluationRun(
        dataset_id=dataset.dataset_id,
        dataset_version=dataset.dataset_version,
        knowledge_release_id=dataset.knowledge_release_id,
        top_k=top_k,
        embedding_model=embedding_model,
        reranker_model=reranker_model,
        case_metrics=case_metrics,
        summary=summary,
    )


def _validate_execution_result(
    *,
    case,
    expected_request: RetrievalRequest,
    result: RetrievalExecutionResult,
    embedding_model: EmbeddingModel,
) -> None:
    if result.request != expected_request:
        raise RetrievalEvaluationRunnerError(
            "Retrieval executor returned a result for a different request."
        )

    if result.embedding_model != embedding_model:
        raise RetrievalEvaluationRunnerError(
            "Retrieval executor returned a different embedding model."
        )

    for item in result.evidence:
        evidence = item.fused_evidence.evidence

        if (
            evidence.tenant_id != case.tenant_id
            or evidence.environment_id != case.environment_id
            or evidence.knowledge_release_id != case.knowledge_release_id
            or evidence.locale != case.locale
            or evidence.classification
            not in {
                classification.value
                for classification in case.allowed_classifications
            }
        ):
            raise RetrievalEvaluationRunnerError(
                "Retrieval executor returned evidence outside the governed "
                "evaluation context."
            )