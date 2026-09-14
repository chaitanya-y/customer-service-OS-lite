import asyncio
import json

import pytest
from pydantic import ValidationError

from evaluation_runner.models import (
    CaseSummary,
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationRun,
    EvaluationSample,
    GraderResult,
    RunSummary,
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


def make_trial(
    case_id: str,
    repetition: int,
    *,
    passed: bool = True,
    grader_results: list[GraderResult] | None = None,
) -> TrialResult:
    selected_grader_results = (
        grader_results
        if grader_results is not None
        else [
            GraderResult(
                grader_name="required-final-state",
                grader_version="v1",
                score=1.0,
                passed=True,
                blocking=True,
            )
        ]
    )
    return TrialResult(
        trial_id=f"run-1:{case_id}:{repetition}",
        case_id=case_id,
        repetition=repetition,
        status=TrialStatus.COMPLETED,
        passed=passed,
        sample=make_sample(),
        grader_results=selected_grader_results,
    )


def make_run() -> EvaluationRun:
    trials = [
        make_trial("case-1", 1),
        make_trial("case-1", 2),
        make_trial("case-2", 1),
        make_trial("case-2", 2),
    ]
    case_summaries = [
        CaseSummary(
            case_id=case_id,
            trial_count=2,
            passed_trial_count=2,
            pass_rate=1.0,
            all_trials_passed=True,
        )
        for case_id in ("case-1", "case-2")
    ]
    return EvaluationRun(
        run_id="run-1",
        dataset_id="refund-agent",
        dataset_version="v1",
        dataset_case_ids=["case-1", "case-2"],
        evaluation_version="evaluation-v1",
        repetitions=2,
        trials=trials,
        case_summaries=case_summaries,
        summary=RunSummary(
            case_count=2,
            trial_count=4,
            passed_trial_count=4,
            pass_rate=1.0,
            consistent_case_count=2,
            consistent_case_rate=1.0,
        ),
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


def test_persisted_completed_trial_requires_grader_results() -> None:
    trial_data = {
        "trial_id": "run-1:case-1:1",
        "case_id": "case-1",
        "repetition": 1,
        "status": "COMPLETED",
        "passed": True,
        "sample": make_sample().model_dump(mode="json"),
        "grader_results": [],
    }

    with pytest.raises(
        ValidationError, match="completed trial requires grader results"
    ):
        TrialResult.model_validate_json(json.dumps(trial_data))


def test_persisted_completed_trial_rejects_passing_with_failed_blocking_grade() -> None:
    trial_data = {
        "trial_id": "run-1:case-1:1",
        "case_id": "case-1",
        "repetition": 1,
        "status": "COMPLETED",
        "passed": True,
        "sample": make_sample().model_dump(mode="json"),
        "grader_results": [
            {
                "grader_name": "required-final-state",
                "grader_version": "v1",
                "score": 0.0,
                "passed": False,
                "blocking": True,
            }
        ],
    }

    with pytest.raises(ValidationError, match="conjunction of blocking grades"):
        TrialResult.model_validate_json(json.dumps(trial_data))


def test_persisted_completed_trial_rejects_failing_with_all_blocking_grades_passing() -> (
    None
):
    trial_data = {
        "trial_id": "run-1:case-1:1",
        "case_id": "case-1",
        "repetition": 1,
        "status": "COMPLETED",
        "passed": False,
        "sample": make_sample().model_dump(mode="json"),
        "grader_results": [
            {
                "grader_name": "required-final-state",
                "grader_version": "v1",
                "score": 1.0,
                "passed": True,
                "blocking": True,
            }
        ],
    }

    with pytest.raises(ValidationError, match="conjunction of blocking grades"):
        TrialResult.model_validate_json(json.dumps(trial_data))


def test_trial_rejects_duplicate_grader_identities() -> None:
    duplicate_grade = GraderResult(
        grader_name="required-final-state",
        grader_version="v1",
        score=1.0,
        passed=True,
        blocking=True,
    )

    with pytest.raises(ValidationError, match="unique grader identities"):
        make_trial(
            "case-1",
            1,
            grader_results=[duplicate_grade, duplicate_grade],
        )


def test_run_rejects_duplicate_trial_ids() -> None:
    run_data = make_run().model_dump()
    run_data["trials"][1]["trial_id"] = run_data["trials"][0]["trial_id"]

    with pytest.raises(ValidationError, match="unique trial IDs"):
        EvaluationRun.model_validate(run_data)


def test_run_rejects_trial_outside_embedded_dataset_cases() -> None:
    run_data = make_run().model_dump()
    run_data["trials"][2]["case_id"] = "case-not-in-dataset"

    with pytest.raises(ValidationError, match="dataset case IDs"):
        EvaluationRun.model_validate(run_data)


def test_run_rejects_missing_or_unexpected_repetitions() -> None:
    run_data = make_run().model_dump()
    run_data["trials"].pop(1)

    with pytest.raises(ValidationError, match="exact repetitions"):
        EvaluationRun.model_validate(run_data)


def test_run_rejects_unexpected_repetition_number() -> None:
    run_data = make_run().model_dump()
    run_data["trials"][1]["repetition"] = 3

    with pytest.raises(ValidationError, match="exact repetitions"):
        EvaluationRun.model_validate(run_data)


def test_run_rejects_case_summary_that_does_not_match_trials() -> None:
    run_data = make_run().model_dump()
    run_data["case_summaries"][0]["passed_trial_count"] = 1
    run_data["case_summaries"][0]["pass_rate"] = 0.5
    run_data["case_summaries"][0]["all_trials_passed"] = False

    with pytest.raises(ValidationError, match="case summaries"):
        EvaluationRun.model_validate(run_data)


def test_run_rejects_aggregate_summary_that_does_not_match_evidence() -> None:
    run_data = make_run().model_dump()
    run_data["summary"]["passed_trial_count"] = 3
    run_data["summary"]["pass_rate"] = 0.75

    with pytest.raises(ValidationError, match="aggregate summary"):
        EvaluationRun.model_validate(run_data)


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
