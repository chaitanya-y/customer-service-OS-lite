import asyncio

import pytest

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
    GraderResult,
    TrialStatus,
)
from evaluation_runner.runner import EvaluationRunError, run_evaluation


def make_case(case_id: str) -> EvaluationCase:
    return EvaluationCase(
        case_id=case_id,
        name=f"Evaluation case {case_id}",
        capability=EvaluationCapability.AGENT,
        input={"customer_message": "Please help with my refund."},
        expectations={"required_final_state": {"refund_count": 1}},
        tags=["refund"],
    )


def make_dataset(case_count: int = 2) -> EvaluationDataset:
    return EvaluationDataset(
        dataset_id="refund-agent",
        dataset_version="v1",
        cases=[make_case(f"case-{index}") for index in range(1, case_count + 1)],
    )


def make_sample(*, repetition: int = 1) -> EvaluationSample:
    return EvaluationSample(
        output={"status": "refund_proposal_ready", "repetition": repetition},
        final_state={"refund_count": 1},
        latency_ms=100,
        versions={"evaluation_version": "evaluation-v1"},
    )


class RecordingSystem:
    def __init__(self) -> None:
        self.calls: list[tuple[str, int]] = []

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        self.calls.append((case.case_id, repetition))
        return make_sample(repetition=repetition)


class AlwaysPassGrader:
    name = "always-pass"
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


class AlwaysFailGrader:
    name = "always-fail"
    version = "v1"

    def __init__(self, *, blocking: bool) -> None:
        self.blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=0.0,
            passed=False,
            blocking=self.blocking,
            reasons=["Synthetic failure."],
        )


def run_with(
    *,
    dataset: EvaluationDataset | None = None,
    system=None,
    graders=None,
    repetitions: int = 1,
):
    selected_dataset = dataset if dataset is not None else make_dataset()
    selected_system = system if system is not None else RecordingSystem()
    selected_graders = graders if graders is not None else [AlwaysPassGrader()]
    return asyncio.run(
        run_evaluation(
            dataset=selected_dataset,
            system=selected_system,
            graders=selected_graders,
            repetitions=repetitions,
            run_id="run-001",
            evaluation_version="evaluation-v1",
        )
    )


def test_runner_executes_every_case_for_every_repetition() -> None:
    system = RecordingSystem()

    result = run_with(system=system, repetitions=3)

    assert system.calls == [
        ("case-1", 1),
        ("case-1", 2),
        ("case-1", 3),
        ("case-2", 1),
        ("case-2", 2),
        ("case-2", 3),
    ]
    assert result.summary.trial_count == 6
    assert result.summary.passed_trial_count == 6
    assert result.summary.pass_rate == 1.0
    assert result.summary.consistent_case_rate == 1.0


def test_system_error_is_a_failed_trial_and_later_cases_still_run() -> None:
    class FirstCaseFailsSystem(RecordingSystem):
        async def run(
            self,
            case: EvaluationCase,
            *,
            repetition: int,
        ) -> EvaluationSample:
            self.calls.append((case.case_id, repetition))
            if case.case_id == "case-1":
                raise RuntimeError("synthetic system failure")
            return make_sample(repetition=repetition)

    system = FirstCaseFailsSystem()

    result = run_with(system=system)

    assert system.calls == [("case-1", 1), ("case-2", 1)]
    assert result.trials[0].status is TrialStatus.SYSTEM_ERROR
    assert result.trials[0].passed is False
    assert result.trials[0].error_message == ("RuntimeError: synthetic system failure")
    assert result.trials[1].status is TrialStatus.COMPLETED
    assert result.summary.pass_rate == 0.5


def test_grader_error_invalidates_the_run_instead_of_scoring_the_system() -> None:
    class ExplodingGrader:
        name = "exploding-grader"
        version = "v1"

        async def grade(
            self,
            case: EvaluationCase,
            sample: EvaluationSample,
        ) -> GraderResult:
            raise RuntimeError("broken evaluator")

    with pytest.raises(
        EvaluationRunError,
        match="exploding-grader.*case-1.*repetition 1",
    ):
        run_with(graders=[ExplodingGrader()])


def test_non_blocking_failure_is_visible_without_failing_trial() -> None:
    result = run_with(
        dataset=make_dataset(case_count=1),
        graders=[AlwaysFailGrader(blocking=False)],
    )

    assert result.trials[0].passed is True
    assert result.trials[0].grader_results[0].passed is False
    assert result.trials[0].grader_results[0].blocking is False
    assert result.summary.pass_rate == 1.0


def test_blocking_failure_fails_trial_and_consistency() -> None:
    result = run_with(
        dataset=make_dataset(case_count=1),
        graders=[AlwaysFailGrader(blocking=True)],
        repetitions=3,
    )

    assert [trial.passed for trial in result.trials] == [False, False, False]
    assert result.case_summaries[0].pass_rate == 0.0
    assert result.case_summaries[0].all_trials_passed is False
    assert result.summary.consistent_case_rate == 0.0


def test_consistency_requires_every_repetition_to_pass() -> None:
    class FailSecondRepetitionGrader:
        name = "fail-second-repetition"
        version = "v1"

        async def grade(
            self,
            case: EvaluationCase,
            sample: EvaluationSample,
        ) -> GraderResult:
            passed = sample.output["repetition"] != 2
            return GraderResult(
                grader_name=self.name,
                grader_version=self.version,
                score=1.0 if passed else 0.0,
                passed=passed,
                blocking=True,
            )

    result = run_with(
        dataset=make_dataset(case_count=1),
        graders=[FailSecondRepetitionGrader()],
        repetitions=3,
    )

    assert result.case_summaries[0].passed_trial_count == 2
    assert result.case_summaries[0].pass_rate == pytest.approx(2 / 3)
    assert result.case_summaries[0].all_trials_passed is False
    assert result.summary.passed_trial_count == 2
    assert result.summary.consistent_case_count == 0


def test_runner_rejects_mismatched_grader_identity() -> None:
    class MismatchedGrader(AlwaysPassGrader):
        name = "declared-name"

        async def grade(
            self,
            case: EvaluationCase,
            sample: EvaluationSample,
        ) -> GraderResult:
            result = await super().grade(case, sample)
            return result.model_copy(update={"grader_name": "other-name"})

    with pytest.raises(
        EvaluationRunError,
        match="returned mismatched identity",
    ):
        run_with(graders=[MismatchedGrader()])
