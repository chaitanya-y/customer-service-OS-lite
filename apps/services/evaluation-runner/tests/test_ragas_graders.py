import asyncio
import math

import pytest

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
)
from evaluation_runner.ragas_graders import (
    RagasGrader,
    RagasGraderError,
    RagasMetricName,
)
from evaluation_runner.runner import EvaluationRunError, run_evaluation


def make_case() -> EvaluationCase:
    return EvaluationCase(
        case_id="damaged-item-answer-v1",
        name="Damaged item answer",
        capability=EvaluationCapability.ANSWER,
        input={"user_input": "What do I need for a damaged-item refund?"},
        expectations={
            "reference": (
                "Provide clear damage photos. The order and affected item must "
                "be verified before review."
            )
        },
        tags=["rag", "answer"],
    )


def make_sample() -> EvaluationSample:
    return EvaluationSample(
        output={
            "response": (
                "Please provide clear photos of the damage so the order and "
                "item can be reviewed."
            ),
            "retrieved_contexts": [
                "Damage photos are required before a damaged-item review.",
                "The order and affected item must be verified.",
            ],
        },
        final_state={"answer_completed": True},
        latency_ms=25,
        versions={"answer_prompt": "refund-answer-v3"},
    )


class RecordingScorer:
    def __init__(self, score: float = 0.9) -> None:
        self.result = score
        self.calls = []

    async def score(self, metric: RagasMetricName, **inputs: object) -> float:
        self.calls.append((metric, inputs))
        return self.result


@pytest.mark.parametrize(
    ("metric", "expected_inputs"),
    [
        (
            RagasMetricName.CONTEXT_PRECISION,
            {
                "user_input": "What do I need for a damaged-item refund?",
                "retrieved_contexts": [
                    "Damage photos are required before a damaged-item review.",
                    "The order and affected item must be verified.",
                ],
                "reference": (
                    "Provide clear damage photos. The order and affected item "
                    "must be verified before review."
                ),
            },
        ),
        (
            RagasMetricName.CONTEXT_RECALL,
            {
                "user_input": "What do I need for a damaged-item refund?",
                "retrieved_contexts": [
                    "Damage photos are required before a damaged-item review.",
                    "The order and affected item must be verified.",
                ],
                "reference": (
                    "Provide clear damage photos. The order and affected item "
                    "must be verified before review."
                ),
            },
        ),
        (
            RagasMetricName.FAITHFULNESS,
            {
                "user_input": "What do I need for a damaged-item refund?",
                "response": (
                    "Please provide clear photos of the damage so the order and "
                    "item can be reviewed."
                ),
                "retrieved_contexts": [
                    "Damage photos are required before a damaged-item review.",
                    "The order and affected item must be verified.",
                ],
            },
        ),
        (
            RagasMetricName.RESPONSE_RELEVANCY,
            {
                "user_input": "What do I need for a damaged-item refund?",
                "response": (
                    "Please provide clear photos of the damage so the order and "
                    "item can be reviewed."
                ),
            },
        ),
        (
            RagasMetricName.FACTUAL_CORRECTNESS,
            {
                "response": (
                    "Please provide clear photos of the damage so the order and "
                    "item can be reviewed."
                ),
                "reference": (
                    "Provide clear damage photos. The order and affected item "
                    "must be verified before review."
                ),
            },
        ),
    ],
)
def test_ragas_grader_sends_only_metric_inputs(
    metric: RagasMetricName,
    expected_inputs: dict[str, object],
) -> None:
    scorer = RecordingScorer()
    grader = RagasGrader(metric=metric, scorer=scorer, minimum=0.8)

    result = asyncio.run(grader.grade(make_case(), make_sample()))

    assert scorer.calls == [(metric, expected_inputs)]
    assert result.grader_name == f"ragas-{metric.value.replace('_', '-')}"
    assert result.grader_version == "ragas-0.4-adapter-v2"
    assert result.score == 0.9
    assert result.passed is True
    assert result.blocking is False
    assert result.reasons == []
    assert result.details == {
        "minimum": 0.8,
        "observed": 0.9,
        "metric": metric.value,
        **(
            {"mode": "precision"}
            if metric is RagasMetricName.FACTUAL_CORRECTNESS
            else {}
        ),
    }


def test_ragas_grader_reports_below_threshold_without_blocking_by_default() -> None:
    grader = RagasGrader(
        metric=RagasMetricName.FAITHFULNESS,
        scorer=RecordingScorer(0.6),
        minimum=0.8,
    )

    result = asyncio.run(grader.grade(make_case(), make_sample()))

    assert result.passed is False
    assert result.blocking is False
    assert result.reasons == [
        "RAGAS faithfulness score 0.6000 is below the configured minimum 0.8000."
    ]


@pytest.mark.parametrize("metric", list(RagasMetricName))
def test_application_facts_ground_answers_without_inflating_retrieval(metric) -> None:
    case = make_case()
    sample = make_sample()
    original_contexts = list(sample.output["retrieved_contexts"])
    original_reference = case.expectations["reference"]
    sample.output["application_facts"] = [
        "Proposed refund amount: USD 120.00.",
        "No refund has been approved or executed in this evaluation.",
    ]
    sample.output["response"] = "Your USD 999.00 refund is approved."
    scorer = RecordingScorer()

    asyncio.run(
        RagasGrader(metric=metric, scorer=scorer, minimum=0.8).grade(case, sample)
    )

    inputs = scorer.calls[0][1]
    application_context = (
        "Trusted application facts (not retrieved knowledge):\n"
        "Proposed refund amount: USD 120.00.\n"
        "No refund has been approved or executed in this evaluation."
    )
    if metric in {RagasMetricName.CONTEXT_PRECISION, RagasMetricName.CONTEXT_RECALL}:
        assert inputs["retrieved_contexts"] == original_contexts
        assert inputs["reference"] == original_reference
        assert "response" not in inputs
    elif metric is RagasMetricName.FAITHFULNESS:
        assert inputs["retrieved_contexts"] == [*original_contexts, application_context]
        assert "999.00" not in " ".join(inputs["retrieved_contexts"])
    elif metric is RagasMetricName.FACTUAL_CORRECTNESS:
        assert inputs["reference"] == original_reference + "\n\n" + application_context
        assert "999.00" not in inputs["reference"]
    else:
        assert set(inputs) == {"user_input", "response"}
    # Grading must never rewrite the recorded retrieval corpus or the answer key.
    assert sample.output["retrieved_contexts"] == original_contexts
    assert case.expectations["reference"] == original_reference


@pytest.mark.parametrize("facts", [None, "refund approved", [""], [4], ["   "]])
def test_ragas_rejects_malformed_application_facts_before_calling_judge(facts) -> None:
    sample = make_sample()
    sample.output["application_facts"] = facts
    scorer = RecordingScorer()
    grader = RagasGrader(
        metric=RagasMetricName.FAITHFULNESS, scorer=scorer, minimum=0.8
    )

    with pytest.raises(RagasGraderError, match="application_facts"):
        asyncio.run(grader.grade(make_case(), sample))
    assert scorer.calls == []


def test_ragas_grader_can_be_promoted_to_a_reviewed_blocking_gate() -> None:
    grader = RagasGrader(
        metric=RagasMetricName.FAITHFULNESS,
        scorer=RecordingScorer(1.0),
        minimum=1.0,
        blocking=True,
    )

    result = asyncio.run(grader.grade(make_case(), make_sample()))

    assert result.passed is True
    assert result.blocking is True


@pytest.mark.parametrize("invalid_minimum", [-0.1, 1.1, True, "0.8"])
def test_ragas_grader_rejects_invalid_minimum(invalid_minimum) -> None:
    with pytest.raises(ValueError, match="minimum must be a number between 0 and 1"):
        RagasGrader(
            metric=RagasMetricName.FAITHFULNESS,
            scorer=RecordingScorer(),
            minimum=invalid_minimum,
        )


@pytest.mark.parametrize("invalid_score", [-0.1, 1.1, math.nan, True, "0.9"])
def test_ragas_grader_rejects_invalid_score(invalid_score) -> None:
    grader = RagasGrader(
        metric=RagasMetricName.FAITHFULNESS,
        scorer=RecordingScorer(invalid_score),
        minimum=0.8,
    )

    with pytest.raises(RagasGraderError, match="score must be between 0 and 1"):
        asyncio.run(grader.grade(make_case(), make_sample()))


@pytest.mark.parametrize(
    ("case", "sample", "message"),
    [
        (
            make_case().model_copy(
                update={"capability": EvaluationCapability.RETRIEVAL}
            ),
            make_sample(),
            "ANSWER evaluation case",
        ),
        (
            make_case().model_copy(update={"input": {}}),
            make_sample(),
            "user_input",
        ),
        (
            make_case().model_copy(update={"expectations": {}}),
            make_sample(),
            "reference",
        ),
        (
            make_case(),
            make_sample().model_copy(update={"output": {"response": "answer"}}),
            "retrieved_contexts",
        ),
    ],
)
def test_ragas_grader_rejects_malformed_case_or_sample(
    case: EvaluationCase,
    sample: EvaluationSample,
    message: str,
) -> None:
    grader = RagasGrader(
        metric=RagasMetricName.CONTEXT_RECALL,
        scorer=RecordingScorer(),
        minimum=0.8,
    )

    with pytest.raises(RagasGraderError, match=message):
        asyncio.run(grader.grade(case, sample))


def test_ragas_scorer_failure_invalidates_evaluation_run() -> None:
    class FailingScorer:
        async def score(self, metric: RagasMetricName, **inputs: object) -> float:
            raise RuntimeError("judge unavailable")

    class StaticSystem:
        async def run(self, case, *, repetition: int):
            return make_sample()

    grader = RagasGrader(
        metric=RagasMetricName.FAITHFULNESS,
        scorer=FailingScorer(),
        minimum=0.8,
    )
    dataset = EvaluationDataset(
        dataset_id="refund-rag-answer",
        dataset_version="v1",
        cases=[make_case()],
    )

    with pytest.raises(
        EvaluationRunError,
        match="ragas-faithfulness.*damaged-item-answer-v1.*judge unavailable",
    ):
        asyncio.run(
            run_evaluation(
                dataset=dataset,
                system=StaticSystem(),
                graders=[grader],
                repetitions=1,
                run_id="ragas-run-001",
                evaluation_version="ragas-evaluation-v1",
            )
        )
