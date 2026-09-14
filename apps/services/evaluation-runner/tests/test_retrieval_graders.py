import asyncio

import pytest

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
)
from evaluation_runner.retrieval_graders import (
    ForbiddenEvidenceGrader,
    RecallAtKGrader,
    ReciprocalRankGrader,
    RetrievalGraderError,
)
from evaluation_runner.runner import EvaluationRunError, run_evaluation


def make_case() -> EvaluationCase:
    return EvaluationCase(
        case_id="damaged-item-v1",
        name="Damaged-item retrieval",
        capability=EvaluationCapability.RETRIEVAL,
        input={"query_text": "Can I refund a damaged item?"},
        expectations={
            "expected_evidence": [
                {
                    "knowledge_document_id": "refund-policy-current",
                    "chunk_id": "section-003-chunk-001",
                }
            ],
            "forbidden_evidence": [],
        },
        tags=["retrieval"],
    )


def make_sample(
    *,
    recall_at_k=1.0,
    reciprocal_rank=1.0,
    forbidden_evidence_count=0,
) -> EvaluationSample:
    return EvaluationSample(
        output={
            "retrieval_metrics": {
                "recall_at_k": recall_at_k,
                "reciprocal_rank": reciprocal_rank,
                "forbidden_evidence_count": forbidden_evidence_count,
            }
        },
        final_state={"retrieval_completed": True},
        latency_ms=10,
        versions={"adapter": "knowledge-retrieval-adapter-v1"},
    )


def test_recall_at_k_grader_reports_failed_non_blocking_threshold() -> None:
    result = asyncio.run(
        RecallAtKGrader(minimum=0.8).grade(
            make_case(),
            make_sample(recall_at_k=0.75),
        )
    )

    assert result.grader_name == "retrieval-recall-at-k"
    assert result.grader_version == "v1"
    assert result.score == 0.75
    assert result.passed is False
    assert result.blocking is False
    assert result.reasons == [
        "Recall at K 0.7500 is below the configured minimum 0.8000."
    ]
    assert result.details == {"minimum": 0.8, "observed": 0.75}


def test_recall_at_k_grader_can_be_an_explicit_blocking_gate() -> None:
    result = asyncio.run(
        RecallAtKGrader(minimum=1.0, blocking=True).grade(
            make_case(),
            make_sample(recall_at_k=1.0),
        )
    )

    assert result.passed is True
    assert result.blocking is True
    assert result.reasons == []


def test_reciprocal_rank_grader_reports_its_own_score() -> None:
    result = asyncio.run(
        ReciprocalRankGrader(minimum=0.75).grade(
            make_case(),
            make_sample(reciprocal_rank=0.5),
        )
    )

    assert result.grader_name == "retrieval-reciprocal-rank"
    assert result.score == 0.5
    assert result.passed is False
    assert result.blocking is False
    assert result.reasons == [
        "Reciprocal rank 0.5000 is below the configured minimum 0.7500."
    ]


@pytest.mark.parametrize("grader_type", [RecallAtKGrader, ReciprocalRankGrader])
@pytest.mark.parametrize("invalid_minimum", [-0.01, 1.01, True, "0.5"])
def test_quality_graders_reject_invalid_minimum(
    grader_type,
    invalid_minimum,
) -> None:
    with pytest.raises(ValueError, match="minimum must be a number between 0 and 1"):
        grader_type(minimum=invalid_minimum)


def test_forbidden_evidence_grader_passes_only_when_count_is_zero() -> None:
    passing_result = asyncio.run(
        ForbiddenEvidenceGrader().grade(make_case(), make_sample())
    )
    failing_result = asyncio.run(
        ForbiddenEvidenceGrader().grade(
            make_case(),
            make_sample(forbidden_evidence_count=1),
        )
    )

    assert passing_result.score == 1.0
    assert passing_result.passed is True
    assert passing_result.blocking is True
    assert passing_result.reasons == []
    assert failing_result.score == 0.0
    assert failing_result.passed is False
    assert failing_result.blocking is True
    assert failing_result.reasons == ["Retrieved 1 forbidden evidence item."]


@pytest.mark.parametrize(
    ("metric_name", "metric_value", "message"),
    [
        ("recall_at_k", True, "recall_at_k must be numeric"),
        ("recall_at_k", "1.0", "recall_at_k must be numeric"),
        ("recall_at_k", 1.1, "recall_at_k must be between 0 and 1"),
        (
            "forbidden_evidence_count",
            -1,
            "forbidden_evidence_count must be a non-negative integer",
        ),
        (
            "forbidden_evidence_count",
            1.0,
            "forbidden_evidence_count must be a non-negative integer",
        ),
    ],
)
def test_retrieval_graders_reject_malformed_metrics(
    metric_name: str,
    metric_value,
    message: str,
) -> None:
    grader = (
        RecallAtKGrader(minimum=0.5)
        if metric_name == "recall_at_k"
        else ForbiddenEvidenceGrader()
    )
    sample = make_sample()
    metrics = dict(sample.output["retrieval_metrics"])
    metrics[metric_name] = metric_value
    malformed_sample = sample.model_copy(
        update={"output": {"retrieval_metrics": metrics}}
    )

    with pytest.raises(RetrievalGraderError, match=message):
        asyncio.run(grader.grade(make_case(), malformed_sample))


def test_missing_retrieval_metrics_invalidates_run_instead_of_scoring_zero() -> None:
    malformed_sample = make_sample().model_copy(update={"output": {}})

    class StaticSystem:
        async def run(
            self,
            case: EvaluationCase,
            *,
            repetition: int,
        ) -> EvaluationSample:
            return malformed_sample

    dataset = EvaluationDataset(
        dataset_id="retrieval",
        dataset_version="v1",
        cases=[make_case()],
    )

    with pytest.raises(
        EvaluationRunError,
        match="retrieval-recall-at-k.*damaged-item-v1.*repetition 1",
    ):
        asyncio.run(
            run_evaluation(
                dataset=dataset,
                system=StaticSystem(),
                graders=[RecallAtKGrader(minimum=0.5)],
                repetitions=1,
                run_id="retrieval-run-001",
                evaluation_version="retrieval-evaluation-v1",
            )
        )
