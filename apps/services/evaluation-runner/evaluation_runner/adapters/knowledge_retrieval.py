from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter

from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.evaluation import (
    RetrievalEvaluationCase,
    RetrievalEvaluationDataset,
)
from knowledge_rag.evaluation_runner import (
    RetrievalExecutor,
    run_retrieval_evaluation,
)
from knowledge_rag.reranking import RerankerModel
from knowledge_rag.retrieval_service import RetrievalExecutionResult

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)


class KnowledgeRetrievalAdapterError(RuntimeError):
    """Raised when a retrieval case cannot be adapted or executed safely."""


@dataclass(frozen=True)
class AdaptedRetrievalDataset:
    """Generic cases paired with their validated Knowledge/RAG source cases."""

    dataset: EvaluationDataset
    source_dataset: RetrievalEvaluationDataset

    def get_source_case(self, case_id: str) -> RetrievalEvaluationCase:
        for case in self.source_dataset.cases:
            if case.evaluation_case_id == case_id:
                return case

        raise KnowledgeRetrievalAdapterError(
            f"No source retrieval case exists for {case_id!r}."
        )


def adapt_retrieval_dataset(
    source_dataset: RetrievalEvaluationDataset,
) -> AdaptedRetrievalDataset:
    """Preserve validated retrieval cases in the generic evaluation contract."""

    generic_cases = [_adapt_retrieval_case(case) for case in source_dataset.cases]
    return AdaptedRetrievalDataset(
        dataset=EvaluationDataset(
            dataset_id=source_dataset.dataset_id,
            dataset_version=source_dataset.dataset_version,
            cases=generic_cases,
        ),
        source_dataset=source_dataset,
    )


def _adapt_retrieval_case(
    source_case: RetrievalEvaluationCase,
) -> EvaluationCase:
    serialized_case = source_case.model_dump(mode="json")
    return EvaluationCase(
        case_id=source_case.evaluation_case_id,
        name=f"Knowledge retrieval: {source_case.evaluation_case_id}",
        capability=EvaluationCapability.RETRIEVAL,
        input={
            "query_text": serialized_case["query_text"],
            "tenant_id": serialized_case["tenant_id"],
            "environment_id": serialized_case["environment_id"],
            "knowledge_release_id": serialized_case["knowledge_release_id"],
            "allowed_classifications": serialized_case["allowed_classifications"],
            "locale": serialized_case["locale"],
            "as_of": serialized_case["as_of"],
        },
        expectations={
            "expected_evidence": serialized_case["expected_evidence"],
            "forbidden_evidence": serialized_case["forbidden_evidence"],
        },
        tags=["knowledge-rag", "retrieval"],
    )


class KnowledgeRetrievalEvaluatedSystem:
    """Execute a validated Knowledge/RAG case through the common runner."""

    adapter_version = "knowledge-retrieval-adapter-v1"

    def __init__(
        self,
        *,
        adapted_dataset: AdaptedRetrievalDataset,
        executor: RetrievalExecutor,
        embedding_model: EmbeddingModel,
        reranker_model: RerankerModel,
        top_k: int,
        clock: Callable[[], float] = perf_counter,
    ) -> None:
        if top_k <= 0:
            raise ValueError("top_k must be positive")

        self._adapted_dataset = adapted_dataset
        self._executor = executor
        self._embedding_model = embedding_model
        self._reranker_model = reranker_model
        self._top_k = top_k
        self._clock = clock

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        del repetition

        if case.capability is not EvaluationCapability.RETRIEVAL:
            raise KnowledgeRetrievalAdapterError(
                "Knowledge retrieval requires a RETRIEVAL evaluation case."
            )

        source_case = self._adapted_dataset.get_source_case(case.case_id)
        source_dataset = self._adapted_dataset.source_dataset.model_copy(
            update={"cases": [source_case]}
        )
        recording_executor = _RecordingRetrievalExecutor(self._executor)

        started_at = self._clock()
        retrieval_run = run_retrieval_evaluation(
            dataset=source_dataset,
            executor=recording_executor,
            embedding_model=self._embedding_model,
            top_k=self._top_k,
        )
        elapsed_ms = (self._clock() - started_at) * 1_000

        if retrieval_run.reranker_model != self._reranker_model:
            raise KnowledgeRetrievalAdapterError(
                "Retrieval returned an unexpected reranker model."
            )
        if recording_executor.result is None:
            raise KnowledgeRetrievalAdapterError(
                "Retrieval completed without an execution result."
            )
        if elapsed_ms < 0:
            raise KnowledgeRetrievalAdapterError(
                "The monotonic evaluation clock moved backwards."
            )

        metrics = retrieval_run.case_metrics[0]
        evidence = recording_executor.result.evidence
        return EvaluationSample(
            output={
                "retrieval_metrics": {
                    "recall_at_k": metrics.recall_at_k,
                    "reciprocal_rank": metrics.reciprocal_rank,
                    "forbidden_evidence_count": len(
                        metrics.retrieved_forbidden_evidence
                    ),
                },
                "retrieved_evidence": [
                    _evidence_identity(item, rank)
                    for rank, item in enumerate(evidence, start=1)
                ],
                "matched_evidence": [
                    item.model_dump(mode="json") for item in metrics.matched_evidence
                ],
                "forbidden_evidence": [
                    item.model_dump(mode="json")
                    for item in metrics.retrieved_forbidden_evidence
                ],
            },
            final_state={"retrieval_completed": True},
            trace=[
                TraceEvent(
                    sequence=rank,
                    kind=TraceEventKind.RETRIEVAL,
                    name="knowledge_chunk_retrieved",
                    payload={
                        **_evidence_identity(item, rank),
                        "retrieval_methods": (
                            item.fused_evidence.contributing_retrievers
                        ),
                    },
                )
                for rank, item in enumerate(evidence, start=1)
            ],
            latency_ms=elapsed_ms,
            versions={
                "adapter": self.adapter_version,
                "knowledge_release": retrieval_run.knowledge_release_id,
                "embedding_model": _embedding_model_identity(
                    retrieval_run.embedding_model
                ),
                "reranker_model": _reranker_model_identity(
                    retrieval_run.reranker_model
                ),
            },
        )


class _RecordingRetrievalExecutor:
    def __init__(self, delegate: RetrievalExecutor) -> None:
        self._delegate = delegate
        self.result: RetrievalExecutionResult | None = None

    def retrieve(self, request) -> RetrievalExecutionResult:
        self.result = self._delegate.retrieve(request)
        return self.result


def _evidence_identity(item, rank: int) -> dict[str, object]:
    evidence = item.fused_evidence.evidence
    return {
        "rank": rank,
        "knowledge_document_id": evidence.knowledge_document_id,
        "chunk_id": evidence.chunk_id,
        "content_sha256": evidence.content_sha256,
    }


def _embedding_model_identity(model: EmbeddingModel) -> str:
    return (
        f"{model.provider}:{model.model_name}:{model.model_version}:{model.dimension}"
    )


def _reranker_model_identity(model: RerankerModel) -> str:
    return f"{model.provider}:{model.model_name}:{model.model_version}"
