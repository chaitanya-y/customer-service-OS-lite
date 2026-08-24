import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.evaluation import (
    EvidenceReference,
    RetrievalEvaluationCase,
    RetrievalEvaluationError,
    evaluate_retrieval_case,
    load_retrieval_evaluation_dataset,
    summarize_retrieval_metrics,
)

CURRENT_POLICY_DOCUMENT_ID = "refund-policy-current-2026-08-01"
INTERNAL_PLAYBOOK_DOCUMENT_ID = (
    "internal-refund-escalation-playbook-2026-08-01"
)
from knowledge_rag.hybrid_retrieval import FusedEvidence
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.reranking import RerankedEvidence, RerankerModel
from knowledge_rag.retrieval_results import (
    EvidenceCitation,
    RetrievedEvidence,
)

REAL_DATASET_PATH = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "evaluation-datasets"
    / "acme"
    / "refund-retrieval-v1.json"
)

GOVERNED_DATASET_PATH = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "evaluation-datasets"
    / "acme"
    / "refund-governed-retrieval-v1.json"
)


def make_case(
    *,
    expected_evidence: list[EvidenceReference] | None = None,
    forbidden_evidence: list[EvidenceReference] | None = None,
) -> RetrievalEvaluationCase:
    return RetrievalEvaluationCase(
        evaluation_case_id="damaged-item-refund-v1",
        query_text="Can I get a refund for a damaged item?",
        tenant_id="acme",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=[
            KnowledgeDocumentClassification.CUSTOMER_SAFE
        ],
        locale="en-US",
        as_of=datetime(2026, 8, 12, 12, 0, tzinfo=UTC),
        expected_evidence=expected_evidence
        or [evidence_reference(chunk_id="damaged-items")],
        forbidden_evidence=forbidden_evidence or [],
    )


def evidence_reference(
    *,
    chunk_id: str,
    knowledge_document_id: str = CURRENT_POLICY_DOCUMENT_ID,
) -> EvidenceReference:
    return EvidenceReference(
        knowledge_document_id=knowledge_document_id,
        chunk_id=chunk_id,
    )


def make_evidence(
    *,
    chunk_id: str,
    rank: int,
    knowledge_document_id: str = CURRENT_POLICY_DOCUMENT_ID,
) -> RerankedEvidence:
    return RerankedEvidence(
        fused_evidence=FusedEvidence(
            evidence=RetrievedEvidence(
                index_document_id=f"index-{chunk_id}",
                knowledge_document_id=knowledge_document_id,
                chunk_id=chunk_id,
                content=f"Policy text for {chunk_id}.",
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
            reciprocal_rank_fusion_score=0.01,
            contributing_retrievers=["semantic_vector"],
        ),
        reranker_score=float(10 - rank),
        reranker_rank=rank,
        reranker_model=RerankerModel(
            provider="test",
            model_name="test-reranker",
            model_version="v1",
        ),
    )


def test_evaluation_case_builds_the_real_governed_retrieval_request() -> None:
    embedding_model = EmbeddingModel(
        provider="openai",
        model_name="text-embedding-3-small",
        model_version="openai-embeddings-v1",
        dimension=1536,
    )

    request = make_case().to_retrieval_request(
        embedding_model=embedding_model,
        top_k=3,
    )

    assert request.tenant_id == "acme"
    assert request.knowledge_release_id == "refund-policy-2026-08-01"
    assert request.allowed_classifications == [
        KnowledgeDocumentClassification.CUSTOMER_SAFE
    ]
    assert request.embedding_model == embedding_model
    assert request.top_k == 3


def test_evaluate_retrieval_case_calculates_recall_and_reciprocal_rank() -> None:
    case = make_case(
        expected_evidence=[
            evidence_reference(chunk_id="damaged-items"),
            evidence_reference(chunk_id="refund-window"),
        ]
    )

    metrics = evaluate_retrieval_case(
        case=case,
        evidence=[
            make_evidence(chunk_id="final-sale", rank=1),
            make_evidence(chunk_id="damaged-items", rank=2),
            make_evidence(chunk_id="refund-window", rank=3),
        ],
    )

    assert metrics.evaluated_k == 3
    assert metrics.expected_evidence_count == 2
    assert metrics.matched_evidence == [
        evidence_reference(chunk_id="damaged-items"),
        evidence_reference(chunk_id="refund-window"),
    ]
    assert metrics.recall_at_k == 1.0
    assert metrics.reciprocal_rank == 0.5
    assert metrics.retrieved_forbidden_evidence == []
    assert metrics.has_forbidden_evidence is False


def test_evaluate_retrieval_case_returns_zero_when_no_expected_chunk_is_found() -> None:
    metrics = evaluate_retrieval_case(
        case=make_case(),
        evidence=[
            make_evidence(chunk_id="final-sale", rank=1),
            make_evidence(chunk_id="shipping", rank=2),
        ],
    )

    assert metrics.recall_at_k == 0
    assert metrics.reciprocal_rank == 0
    assert metrics.matched_evidence == []


def test_evaluate_retrieval_case_does_not_match_same_chunk_from_another_document() -> None:
    metrics = evaluate_retrieval_case(
        case=make_case(),
        evidence=[
            make_evidence(
                chunk_id="damaged-items",
                rank=1,
                knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
            )
        ],
    )

    assert metrics.recall_at_k == 0
    assert metrics.reciprocal_rank == 0
    assert metrics.matched_evidence == []


def test_evaluate_retrieval_case_rejects_duplicate_results() -> None:
    with pytest.raises(
        RetrievalEvaluationError,
        match="must not contain duplicate document-scoped references",
    ):
        evaluate_retrieval_case(
            case=make_case(),
            evidence=[
                make_evidence(chunk_id="damaged-items", rank=1),
                make_evidence(chunk_id="damaged-items", rank=2),
            ],
        )


def test_evaluation_case_rejects_evidence_that_is_both_expected_and_forbidden() -> None:
    with pytest.raises(
        ValueError,
        match="both expected and forbidden",
    ):
        make_case(
            expected_evidence=[evidence_reference(chunk_id="damaged-items")],
            forbidden_evidence=[evidence_reference(chunk_id="damaged-items")],
        )


def test_evaluate_retrieval_case_reports_forbidden_evidence() -> None:
    metrics = evaluate_retrieval_case(
        case=make_case(
            forbidden_evidence=[
                evidence_reference(
                    chunk_id="internal-escalation-playbook",
                    knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
                )
            ]
        ),
        evidence=[
            make_evidence(
                chunk_id="damaged-items",
                rank=1,
            ),
            make_evidence(
                chunk_id="internal-escalation-playbook",
                rank=2,
                knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
            ),
        ],
    )

    assert metrics.recall_at_k == 1.0
    assert metrics.retrieved_forbidden_evidence == [
        evidence_reference(
            chunk_id="internal-escalation-playbook",
            knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
        )
    ]
    assert metrics.has_forbidden_evidence is True


def test_summarize_retrieval_metrics_calculates_quality_and_safety() -> None:
    safe_metrics = evaluate_retrieval_case(
        case=make_case(),
        evidence=[
            make_evidence(chunk_id="damaged-items", rank=1),
        ],
    )
    unsafe_metrics = evaluate_retrieval_case(
        case=make_case(
            expected_evidence=[evidence_reference(chunk_id="refund-window")],
            forbidden_evidence=[
                evidence_reference(
                    chunk_id="internal-escalation-playbook",
                    knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
                )
            ],
        ).model_copy(
            update={"evaluation_case_id": "refund-window-v1"}
        ),
        evidence=[
            make_evidence(
                chunk_id="internal-escalation-playbook",
                rank=1,
                knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
            ),
            make_evidence(chunk_id="refund-window", rank=2),
        ],
    )

    summary = summarize_retrieval_metrics([safe_metrics, unsafe_metrics])

    assert summary.case_count == 2
    assert summary.mean_recall == 1.0
    assert summary.mean_reciprocal_rank == 0.75
    assert summary.cases_with_forbidden_evidence == 1
    assert summary.forbidden_evidence_rate == 0.5


def test_summarize_retrieval_metrics_rejects_duplicate_case_ids() -> None:
    duplicate_metrics = evaluate_retrieval_case(
        case=make_case(),
        evidence=[
            make_evidence(chunk_id="damaged-items", rank=1),
        ],
    )

    with pytest.raises(
        RetrievalEvaluationError,
        match="unique evaluation case IDs",
    ):
        summarize_retrieval_metrics(
            [duplicate_metrics, duplicate_metrics]
        )


def test_load_retrieval_evaluation_dataset_loads_the_real_fixture() -> None:
    dataset = load_retrieval_evaluation_dataset(REAL_DATASET_PATH)

    assert dataset.dataset_id == "acme-refund-retrieval"
    assert dataset.dataset_version == "v1"
    assert dataset.knowledge_release_id == "refund-policy-2026-08-01"
    assert len(dataset.cases) == 7
    assert dataset.cases[0].expected_evidence == [
        EvidenceReference(
            knowledge_document_id=CURRENT_POLICY_DOCUMENT_ID,
            chunk_id="section-003-chunk-001",
        )
    ]


def test_governed_dataset_covers_access_and_policy_version_boundaries() -> None:
    dataset = load_retrieval_evaluation_dataset(GOVERNED_DATASET_PATH)
    cases_by_id = {
        case.evaluation_case_id: case for case in dataset.cases
    }

    assert len(dataset.cases) == 5
    assert cases_by_id["support-escalation-takeover-v1"].allowed_classifications == [
        KnowledgeDocumentClassification.CUSTOMER_SAFE,
        KnowledgeDocumentClassification.INTERNAL,
    ]
    assert cases_by_id["customer-takeover-boundary-v1"].forbidden_evidence == [
        EvidenceReference(
            knowledge_document_id=INTERNAL_PLAYBOOK_DOCUMENT_ID,
            chunk_id="section-003-chunk-001",
        )
    ]
    assert cases_by_id["historical-damaged-item-policy-v1"].as_of == datetime(
        2026,
        7,
        15,
        12,
        0,
        tzinfo=UTC,
    )


def test_dataset_rejects_duplicate_evaluation_case_ids(
    tmp_path: Path,
) -> None:
    duplicate_case = make_case().model_dump(mode="json")
    path = tmp_path / "duplicate-case-ids.json"
    path.write_text(
        json.dumps(
            {
                "dataset_id": "test-dataset",
                "dataset_version": "v1",
                "knowledge_release_id": "refund-policy-2026-08-01",
                "cases": [duplicate_case, duplicate_case],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        RetrievalEvaluationError,
        match="Evaluation dataset is invalid",
    ):
        load_retrieval_evaluation_dataset(path)


def test_dataset_rejects_a_case_for_a_different_policy_release(
    tmp_path: Path,
) -> None:
    wrong_release_case = make_case().model_dump(mode="json")
    wrong_release_case["knowledge_release_id"] = "refund-policy-2027-01-01"
    path = tmp_path / "wrong-release.json"
    path.write_text(
        json.dumps(
            {
                "dataset_id": "test-dataset",
                "dataset_version": "v1",
                "knowledge_release_id": "refund-policy-2026-08-01",
                "cases": [wrong_release_case],
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(
        RetrievalEvaluationError,
        match="Evaluation dataset is invalid",
    ):
        load_retrieval_evaluation_dataset(path)
