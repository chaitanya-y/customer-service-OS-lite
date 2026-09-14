import asyncio
import json
from datetime import UTC, datetime

import pytest
from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.evaluation import (
    EvidenceReference,
    RetrievalEvaluationCase,
    RetrievalEvaluationDataset,
)
from knowledge_rag.hybrid_retrieval import FusedEvidence
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.reranking import RerankedEvidence, RerankerModel
from knowledge_rag.retrieval_results import (
    EvidenceCitation,
    RetrievedEvidence,
)
from knowledge_rag.retrieval_service import RetrievalExecutionResult

from evaluation_runner.adapters.knowledge_retrieval import (
    KnowledgeRetrievalAdapterError,
    KnowledgeRetrievalEvaluatedSystem,
    adapt_retrieval_dataset,
)
from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    GraderResult,
    TraceEventKind,
    TrialStatus,
)
from evaluation_runner.runner import run_evaluation

EMBEDDING_MODEL = EmbeddingModel(
    provider="test",
    model_name="test-embedding",
    model_version="v1",
    dimension=8,
)

RERANKER_MODEL = RerankerModel(
    provider="test",
    model_name="test-reranker",
    model_version="v1",
)

OTHER_RERANKER_MODEL = RerankerModel(
    provider="test",
    model_name="other-reranker",
    model_version="v2",
)


def make_source_dataset() -> RetrievalEvaluationDataset:
    return RetrievalEvaluationDataset(
        dataset_id="acme-refund-governed-retrieval",
        dataset_version="v1",
        knowledge_release_id="refund-policy-2026-08-01",
        cases=[
            RetrievalEvaluationCase(
                evaluation_case_id="damaged-item-v1",
                query_text="Can I refund a damaged item?",
                tenant_id="acme",
                environment_id="local",
                knowledge_release_id="refund-policy-2026-08-01",
                allowed_classifications=[KnowledgeDocumentClassification.CUSTOMER_SAFE],
                locale="en-US",
                as_of=datetime(2026, 8, 12, 12, 0, tzinfo=UTC),
                expected_evidence=[
                    EvidenceReference(
                        knowledge_document_id=("refund-policy-current-2026-08-01"),
                        chunk_id="section-003-chunk-001",
                    )
                ],
                forbidden_evidence=[
                    EvidenceReference(
                        knowledge_document_id=(
                            "internal-refund-escalation-playbook-2026-08-01"
                        ),
                        chunk_id="section-003-chunk-001",
                    )
                ],
            )
        ],
    )


def test_adapt_retrieval_dataset_preserves_governed_case() -> None:
    source = make_source_dataset()

    adapted = adapt_retrieval_dataset(source)

    assert adapted.dataset.dataset_id == "acme-refund-governed-retrieval"
    assert adapted.dataset.dataset_version == "v1"
    assert len(adapted.dataset.cases) == 1

    case = adapted.dataset.cases[0]
    assert case.case_id == "damaged-item-v1"
    assert case.name == "Knowledge retrieval: damaged-item-v1"
    assert case.capability is EvaluationCapability.RETRIEVAL
    assert case.input == {
        "query_text": "Can I refund a damaged item?",
        "tenant_id": "acme",
        "environment_id": "local",
        "knowledge_release_id": "refund-policy-2026-08-01",
        "allowed_classifications": ["CUSTOMER_SAFE"],
        "locale": "en-US",
        "as_of": "2026-08-12T12:00:00Z",
    }
    assert case.expectations == {
        "expected_evidence": [
            {
                "knowledge_document_id": ("refund-policy-current-2026-08-01"),
                "chunk_id": "section-003-chunk-001",
            }
        ],
        "forbidden_evidence": [
            {
                "knowledge_document_id": (
                    "internal-refund-escalation-playbook-2026-08-01"
                ),
                "chunk_id": "section-003-chunk-001",
            }
        ],
    }
    assert case.tags == ["knowledge-rag", "retrieval"]
    assert adapted.get_source_case("damaged-item-v1") == source.cases[0]


def test_adapted_dataset_rejects_unknown_source_case() -> None:
    adapted = adapt_retrieval_dataset(make_source_dataset())

    with pytest.raises(
        KnowledgeRetrievalAdapterError,
        match="No source retrieval case exists for 'unknown-case'",
    ):
        adapted.get_source_case("unknown-case")


def make_evidence(
    *,
    chunk_id: str,
    rank: int,
    content_sha256: str,
    tenant_id: str = "acme",
    reranker_model: RerankerModel = RERANKER_MODEL,
) -> RerankedEvidence:
    return RerankedEvidence(
        fused_evidence=FusedEvidence(
            evidence=RetrievedEvidence(
                index_document_id=f"index-{chunk_id}",
                knowledge_document_id="refund-policy-current-2026-08-01",
                chunk_id=chunk_id,
                content=f"Synthetic policy content for {chunk_id}.",
                content_sha256=content_sha256,
                retrieval_score=1.0,
                knowledge_release_id="refund-policy-2026-08-01",
                tenant_id=tenant_id,
                environment_id="local",
                classification="CUSTOMER_SAFE",
                locale="en-US",
                citation=EvidenceCitation(
                    source_uri="s3://synthetic/refund-policy.md",
                    title="Synthetic Refund Policy",
                    section_path=["Refund policy", chunk_id],
                ),
            ),
            reciprocal_rank_fusion_score=0.02 / rank,
            contributing_retrievers=[
                "semantic_vector",
                "lexical_keyword",
            ],
        ),
        reranker_score=1.0 / rank,
        reranker_rank=rank,
        reranker_model=reranker_model,
    )


def make_execution_result(
    *,
    request,
    tenant_id: str = "acme",
    reranker_model: RerankerModel = RERANKER_MODEL,
) -> RetrievalExecutionResult:
    return RetrievalExecutionResult(
        request=request,
        embedding_model=EMBEDDING_MODEL,
        reranker_model=reranker_model,
        fused_candidate_count=2,
        evidence=[
            make_evidence(
                chunk_id="section-001-chunk-001",
                rank=1,
                content_sha256="a" * 64,
                tenant_id=tenant_id,
                reranker_model=reranker_model,
            ),
            make_evidence(
                chunk_id="section-003-chunk-001",
                rank=2,
                content_sha256="b" * 64,
                tenant_id=tenant_id,
                reranker_model=reranker_model,
            ),
        ],
    )


class FakeRetrievalExecutor:
    def __init__(
        self,
        *,
        tenant_id: str = "acme",
        reranker_model: RerankerModel = RERANKER_MODEL,
    ) -> None:
        self.tenant_id = tenant_id
        self.reranker_model = reranker_model
        self.requests = []

    @property
    def call_count(self) -> int:
        return len(self.requests)

    def retrieve(self, request) -> RetrievalExecutionResult:
        self.requests.append(request)
        return make_execution_result(
            request=request,
            tenant_id=self.tenant_id,
            reranker_model=self.reranker_model,
        )


class AlwaysPassGrader:
    name = "test-always-pass"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0,
            passed=True,
            blocking=True,
        )


def make_system(
    *,
    executor: FakeRetrievalExecutor | None = None,
    clock=None,
) -> tuple[KnowledgeRetrievalEvaluatedSystem, FakeRetrievalExecutor]:
    selected_executor = executor or FakeRetrievalExecutor()
    adapted = adapt_retrieval_dataset(make_source_dataset())
    kwargs = {}
    if clock is not None:
        kwargs["clock"] = clock

    return (
        KnowledgeRetrievalEvaluatedSystem(
            adapted_dataset=adapted,
            executor=selected_executor,
            embedding_model=EMBEDDING_MODEL,
            reranker_model=RERANKER_MODEL,
            top_k=3,
            **kwargs,
        ),
        selected_executor,
    )


def test_retrieval_system_returns_metrics_ranked_trace_and_versions() -> None:
    clock_values = iter([10.0, 10.125])
    system, executor = make_system(clock=lambda: next(clock_values))
    case = adapt_retrieval_dataset(make_source_dataset()).dataset.cases[0]

    sample = asyncio.run(system.run(case, repetition=1))

    assert executor.call_count == 1
    assert sample.output["retrieval_metrics"] == {
        "recall_at_k": 1.0,
        "reciprocal_rank": 0.5,
        "forbidden_evidence_count": 0,
    }
    assert sample.output["matched_evidence"] == [
        {
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
        }
    ]
    assert sample.output["forbidden_evidence"] == []
    assert sample.output["retrieved_evidence"] == [
        {
            "rank": 1,
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-001-chunk-001",
            "content_sha256": "a" * 64,
        },
        {
            "rank": 2,
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
            "content_sha256": "b" * 64,
        },
    ]
    assert sample.final_state == {"retrieval_completed": True}
    assert sample.latency_ms == 125.0
    assert [event.sequence for event in sample.trace] == [1, 2]
    assert [event.kind for event in sample.trace] == [
        TraceEventKind.RETRIEVAL,
        TraceEventKind.RETRIEVAL,
    ]
    assert sample.trace[1].payload == {
        "rank": 2,
        "knowledge_document_id": "refund-policy-current-2026-08-01",
        "chunk_id": "section-003-chunk-001",
        "content_sha256": "b" * 64,
        "retrieval_methods": ["semantic_vector", "lexical_keyword"],
    }
    assert sample.versions == {
        "adapter": "knowledge-retrieval-adapter-v1",
        "knowledge_release": "refund-policy-2026-08-01",
        "embedding_model": "test:test-embedding:v1:8",
        "reranker_model": "test:test-reranker:v1",
    }
    serialized_sample = json.dumps(sample.model_dump(mode="json"))
    assert "Synthetic policy content" not in serialized_sample


def test_retrieval_system_rejects_a_non_retrieval_case() -> None:
    system, _ = make_system()
    source_case = adapt_retrieval_dataset(make_source_dataset()).dataset.cases[0]
    wrong_capability_case = source_case.model_copy(
        update={"capability": EvaluationCapability.AGENT}
    )

    with pytest.raises(
        KnowledgeRetrievalAdapterError,
        match="requires a RETRIEVAL evaluation case",
    ):
        asyncio.run(system.run(wrong_capability_case, repetition=1))


def test_retrieval_system_runs_every_repetition_through_common_runner() -> None:
    adapted = adapt_retrieval_dataset(make_source_dataset())
    system, executor = make_system()

    result = asyncio.run(
        run_evaluation(
            dataset=adapted.dataset,
            system=system,
            graders=[AlwaysPassGrader()],
            repetitions=3,
            run_id="retrieval-run-001",
            evaluation_version="retrieval-evaluation-v1",
        )
    )

    assert executor.call_count == 3
    assert result.summary.trial_count == 3
    assert result.summary.consistent_case_rate == 1.0


@pytest.mark.parametrize(
    ("executor", "error_fragment"),
    [
        (
            FakeRetrievalExecutor(tenant_id="other-tenant"),
            "outside the governed evaluation context",
        ),
        (
            FakeRetrievalExecutor(reranker_model=OTHER_RERANKER_MODEL),
            "unexpected reranker model",
        ),
    ],
)
def test_retrieval_system_records_governance_or_version_violation_as_system_error(
    executor: FakeRetrievalExecutor,
    error_fragment: str,
) -> None:
    adapted = adapt_retrieval_dataset(make_source_dataset())
    system, _ = make_system(executor=executor)

    result = asyncio.run(
        run_evaluation(
            dataset=adapted.dataset,
            system=system,
            graders=[AlwaysPassGrader()],
            repetitions=1,
            run_id="retrieval-run-001",
            evaluation_version="retrieval-evaluation-v1",
        )
    )

    trial = result.trials[0]
    assert trial.status is TrialStatus.SYSTEM_ERROR
    assert trial.passed is False
    assert trial.sample is None
    assert trial.grader_results == []
    assert error_fragment in trial.error_message
