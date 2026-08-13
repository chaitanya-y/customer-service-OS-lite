from datetime import UTC, datetime

import pytest

from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.evaluation import (
    EvidenceReference,
    RetrievalEvaluationCase,
    RetrievalEvaluationDataset,
)
from knowledge_rag.evaluation_runner import (
    RetrievalEvaluationRunnerError,
    run_retrieval_evaluation,
)
from knowledge_rag.hybrid_retrieval import FusedEvidence
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.reranking import RerankedEvidence, RerankerModel
from knowledge_rag.retrieval_results import (
    EvidenceCitation,
    RetrievedEvidence,
)
from knowledge_rag.retrieval_service import RetrievalExecutionResult

EMBEDDING_MODEL = EmbeddingModel(
    provider="test",
    model_name="test-embedding",
    model_version="v1",
    dimension=8,
)

CURRENT_POLICY_DOCUMENT_ID = "refund-policy-current-2026-08-01"

RERANKER_MODEL = RerankerModel(
    provider="test",
    model_name="test-reranker",
    model_version="v1",
)


def make_dataset() -> RetrievalEvaluationDataset:
    return RetrievalEvaluationDataset(
        dataset_id="acme-refund-retrieval",
        dataset_version="v1",
        knowledge_release_id="refund-policy-2026-08-01",
        cases=[
            make_case(
                evaluation_case_id="damaged-item-refund-v1",
                query_text="Can I get a refund for a damaged item?",
                expected_evidence=EvidenceReference(
                    knowledge_document_id=CURRENT_POLICY_DOCUMENT_ID,
                    chunk_id="section-003-chunk-001",
                ),
            ),
            make_case(
                evaluation_case_id="missing-item-refund-v1",
                query_text="Can I get a refund for a missing item?",
                expected_evidence=EvidenceReference(
                    knowledge_document_id=CURRENT_POLICY_DOCUMENT_ID,
                    chunk_id="section-004-chunk-001",
                ),
            ),
        ],
    )


def make_case(
    *,
    evaluation_case_id: str,
    query_text: str,
    expected_evidence: EvidenceReference,
) -> RetrievalEvaluationCase:
    return RetrievalEvaluationCase(
        evaluation_case_id=evaluation_case_id,
        query_text=query_text,
        tenant_id="acme",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=[
            KnowledgeDocumentClassification.CUSTOMER_SAFE
        ],
        locale="en-US",
        as_of=datetime(2026, 8, 12, 12, 0, tzinfo=UTC),
        expected_evidence=[expected_evidence],
    )


def make_result(
    *,
    request,
    chunk_id: str,
    reranker_model: RerankerModel = RERANKER_MODEL,
    tenant_id: str = "acme",
) -> RetrievalExecutionResult:
    evidence = RerankedEvidence(
        fused_evidence=FusedEvidence(
            evidence=RetrievedEvidence(
                index_document_id=f"index-{chunk_id}",
                knowledge_document_id=CURRENT_POLICY_DOCUMENT_ID,
                chunk_id=chunk_id,
                content=f"Policy text for {chunk_id}.",
                content_sha256="a" * 64,
                retrieval_score=1.0,
                knowledge_release_id="refund-policy-2026-08-01",
                tenant_id=tenant_id,
                environment_id="local",
                classification="CUSTOMER_SAFE",
                locale="en-US",
                citation=EvidenceCitation(
                    source_uri="s3://cso-knowledge/acme/refund-policy.md",
                    title="Acme Refund Policy",
                    section_path=["Acme Refund Policy", chunk_id],
                ),
            ),
            reciprocal_rank_fusion_score=0.01,
            contributing_retrievers=["semantic_vector"],
        ),
        reranker_score=1.0,
        reranker_rank=1,
        reranker_model=reranker_model,
    )

    return RetrievalExecutionResult(
        request=request,
        embedding_model=EMBEDDING_MODEL,
        reranker_model=reranker_model,
        fused_candidate_count=1,
        evidence=[evidence],
    )


class FakeExecutor:
    def __init__(self) -> None:
        self.requests = []

    def retrieve(self, request):
        self.requests.append(request)

        if "damaged" in request.query_text:
            chunk_id = "section-003-chunk-001"
        else:
            chunk_id = "section-004-chunk-001"

        return make_result(request=request, chunk_id=chunk_id)


def test_run_retrieval_evaluation_runs_all_cases_and_summarizes() -> None:
    executor = FakeExecutor()

    run = run_retrieval_evaluation(
        dataset=make_dataset(),
        executor=executor,
        embedding_model=EMBEDDING_MODEL,
        top_k=3,
    )

    assert len(executor.requests) == 2
    assert run.dataset_id == "acme-refund-retrieval"
    assert run.top_k == 3
    assert run.summary.case_count == 2
    assert run.summary.mean_recall == 1.0
    assert run.summary.mean_reciprocal_rank == 1.0
    assert run.summary.forbidden_evidence_rate == 0.0


def test_run_retrieval_evaluation_rejects_a_result_for_a_different_request() -> None:
    class WrongRequestExecutor:
        def retrieve(self, request):
            wrong_request = request.model_copy(
                update={"tenant_id": "other-tenant"}
            )
            return make_result(
                request=wrong_request,
                chunk_id="section-003-chunk-001",
            )

    with pytest.raises(
        RetrievalEvaluationRunnerError,
        match="different request",
    ):
        run_retrieval_evaluation(
            dataset=make_dataset(),
            executor=WrongRequestExecutor(),
            embedding_model=EMBEDDING_MODEL,
            top_k=3,
        )


def test_run_retrieval_evaluation_rejects_evidence_outside_context() -> None:
    class CrossTenantExecutor:
        def retrieve(self, request):
            return make_result(
                request=request,
                chunk_id="section-003-chunk-001",
                tenant_id="other-tenant",
            )

    with pytest.raises(
        RetrievalEvaluationRunnerError,
        match="outside the governed evaluation context",
    ):
        run_retrieval_evaluation(
            dataset=make_dataset(),
            executor=CrossTenantExecutor(),
            embedding_model=EMBEDDING_MODEL,
            top_k=3,
        )


def test_run_retrieval_evaluation_rejects_mixed_reranker_models() -> None:
    class MixedRerankerExecutor:
        def __init__(self) -> None:
            self.call_count = 0

        def retrieve(self, request):
            self.call_count += 1
            reranker_model = (
                RERANKER_MODEL
                if self.call_count == 1
                else RerankerModel(
                    provider="test",
                    model_name="different-reranker",
                    model_version="v1",
                )
            )

            return make_result(
                request=request,
                chunk_id=(
                    "section-003-chunk-001"
                    if self.call_count == 1
                    else "section-004-chunk-001"
                ),
                reranker_model=reranker_model,
            )

    with pytest.raises(
        RetrievalEvaluationRunnerError,
        match="cannot mix reranker models",
    ):
        run_retrieval_evaluation(
            dataset=make_dataset(),
            executor=MixedRerankerExecutor(),
            embedding_model=EMBEDDING_MODEL,
            top_k=3,
        )
