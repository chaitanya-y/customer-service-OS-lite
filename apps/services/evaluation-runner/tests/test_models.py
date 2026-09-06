import asyncio

import pytest
from pydantic import ValidationError

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
    GraderResult,
    TraceEvent,
    TraceEventKind,
    TrialResult,
    TrialStatus,
)
from evaluation_runner.protocols import EvaluatedSystem, Grader


def make_case(
    case_id: str = "refund-damaged-item",
    *,
    tags: list[str] | None = None,
) -> EvaluationCase:
    return EvaluationCase(
        case_id=case_id,
        name="Damaged item refund",
        capability=EvaluationCapability.AGENT,
        input={"customer_message": "The item arrived damaged."},
        expectations={"required_final_state": {"refund_count": 1}},
        tags=tags or ["refund", "damaged-item"],
    )


def make_sample() -> EvaluationSample:
    return EvaluationSample(
        output={"status": "refund_proposal_ready"},
        final_state={"refund_count": 1},
        trace=[
            TraceEvent(
                sequence=1,
                kind=TraceEventKind.TOOL_CALL,
                name="lookup_order",
                payload={"order_reference": "ORDER-001"},
            )
        ],
        latency_ms=125.5,
        input_tokens=120,
        output_tokens=40,
        estimated_cost_usd=0.0012,
        versions={
            "agent_release_id": "agent-runtime-0.1.0",
            "policy_release_id": "refund-policy-v2",
        },
    )


def test_dataset_rejects_duplicate_case_ids() -> None:
    with pytest.raises(ValidationError, match="duplicate case IDs"):
        EvaluationDataset(
            dataset_id="refund-agent",
            dataset_version="v1",
            cases=[make_case("case-1"), make_case("case-1")],
        )


def test_case_rejects_duplicate_tags() -> None:
    with pytest.raises(ValidationError, match="duplicate tags"):
        make_case(tags=["refund", "refund"])


def test_sample_rejects_trace_events_out_of_order() -> None:
    sample_data = make_sample().model_dump()
    sample_data["trace"] = [
        TraceEvent(
            sequence=2,
            kind=TraceEventKind.MODEL_CALL,
            name="refund_intent",
        ).model_dump(),
        TraceEvent(
            sequence=1,
            kind=TraceEventKind.TOOL_CALL,
            name="lookup_order",
        ).model_dump(),
    ]

    with pytest.raises(ValidationError, match="strictly increasing"):
        EvaluationSample.model_validate(sample_data)


def test_completed_trial_requires_sample() -> None:
    with pytest.raises(ValidationError, match="completed trial requires a sample"):
        TrialResult(
            trial_id="run-1:case-1:1",
            case_id="case-1",
            repetition=1,
            status=TrialStatus.COMPLETED,
            passed=False,
            sample=None,
            grader_results=[],
        )


def test_system_error_trial_requires_error_and_cannot_pass() -> None:
    with pytest.raises(ValidationError, match="system-error trial"):
        TrialResult(
            trial_id="run-1:case-1:1",
            case_id="case-1",
            repetition=1,
            status=TrialStatus.SYSTEM_ERROR,
            passed=True,
            sample=make_sample(),
            error_message=None,
            grader_results=[],
        )


def test_completed_trial_preserves_versioned_grades_and_sample() -> None:
    grade = GraderResult(
        grader_name="required-final-state",
        grader_version="v1",
        score=1.0,
        passed=True,
        blocking=True,
    )

    trial = TrialResult(
        trial_id="run-1:case-1:1",
        case_id="case-1",
        repetition=1,
        status=TrialStatus.COMPLETED,
        passed=True,
        sample=make_sample(),
        grader_results=[grade],
    )

    assert trial.sample is not None
    assert trial.sample.versions["policy_release_id"] == "refund-policy-v2"
    assert trial.grader_results == [grade]


async def run_system(
    system: EvaluatedSystem,
    case: EvaluationCase,
) -> EvaluationSample:
    return await system.run(case, repetition=1)


async def run_grader(
    grader: Grader,
    case: EvaluationCase,
    sample: EvaluationSample,
) -> GraderResult:
    return await grader.grade(case, sample)


def test_protocols_accept_structural_system_and_grader_implementations() -> None:
    sample = make_sample()
    grade = GraderResult(
        grader_name="test-grader",
        grader_version="v1",
        score=1.0,
        passed=True,
        blocking=True,
    )

    class FakeSystem:
        async def run(
            self,
            case: EvaluationCase,
            *,
            repetition: int,
        ) -> EvaluationSample:
            assert case.case_id == "refund-damaged-item"
            assert repetition == 1
            return sample

    class FakeGrader:
        name = "test-grader"
        version = "v1"

        async def grade(
            self,
            case: EvaluationCase,
            observed_sample: EvaluationSample,
        ) -> GraderResult:
            assert case.case_id == "refund-damaged-item"
            assert observed_sample == sample
            return grade

    case = make_case()

    assert asyncio.run(run_system(FakeSystem(), case)) == sample
    assert asyncio.run(run_grader(FakeGrader(), case, sample)) == grade
