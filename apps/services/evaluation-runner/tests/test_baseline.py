import pytest

from evaluation_runner.baseline import BaselineComparisonError, compare_runs
from evaluation_runner.models import (
    CaseSummary,
    EvaluationRun,
    EvaluationSample,
    GraderResult,
    RunSummary,
    TrialResult,
    TrialStatus,
)


def make_sample(*, versions: dict[str, str] | None = None) -> EvaluationSample:
    return EvaluationSample(
        output={"status": "refund_proposal_ready"},
        final_state={"refund_count": 1},
        latency_ms=100,
        versions=versions
        or {
            "answer_model": "answer-v1",
            "answer_prompt": "prompt-v1",
            "judge_model": "judge-v1",
            "judge_embedding_model": "embedding-v1",
            "judge_max_tokens": "4096",
        },
    )


def make_grade(
    *,
    name: str = "required-final-state",
    version: str = "v1",
    score: float = 1.0,
    passed: bool = True,
    blocking: bool = True,
) -> GraderResult:
    return GraderResult(
        grader_name=name,
        grader_version=version,
        score=score,
        passed=passed,
        blocking=blocking,
    )


def make_run(
    *,
    dataset_id: str = "refund-agent",
    dataset_version: str = "v1",
    case_id: str = "case-1",
    grades: list[GraderResult] | None = None,
    evaluation_version: str = "evaluation-v1",
    sample_versions: dict[str, str] | None = None,
    system_error: bool = False,
    repetitions: int = 1,
) -> EvaluationRun:
    grader_results = grades if grades is not None else [make_grade()]
    passed = all(grade.passed for grade in grader_results if grade.blocking)
    trials = []
    for repetition in range(1, repetitions + 1):
        if system_error:
            trial = TrialResult(
                trial_id=f"run-1:{case_id}:{repetition}",
                case_id=case_id,
                repetition=repetition,
                status=TrialStatus.SYSTEM_ERROR,
                passed=False,
                error_message="RuntimeError: provider unavailable",
                grader_results=[],
            )
        else:
            trial = TrialResult(
                trial_id=f"run-1:{case_id}:{repetition}",
                case_id=case_id,
                repetition=repetition,
                status=TrialStatus.COMPLETED,
                passed=passed,
                sample=make_sample(versions=sample_versions),
                grader_results=grader_results,
            )
        trials.append(trial)
    if system_error:
        passed = False
    case_summary = CaseSummary(
        case_id=case_id,
        trial_count=repetitions,
        passed_trial_count=repetitions if passed else 0,
        pass_rate=float(passed),
        all_trials_passed=passed,
    )
    return EvaluationRun(
        run_id="run-1",
        dataset_id=dataset_id,
        dataset_version=dataset_version,
        dataset_case_ids=[case_id],
        evaluation_version=evaluation_version,
        repetitions=repetitions,
        trials=trials,
        case_summaries=[case_summary],
        summary=RunSummary(
            case_count=1,
            trial_count=repetitions,
            passed_trial_count=repetitions if passed else 0,
            pass_rate=float(passed),
            consistent_case_count=int(passed),
            consistent_case_rate=float(passed),
        ),
    )


def test_comparison_rejects_different_dataset_identity() -> None:
    baseline = make_run()
    candidate = make_run(dataset_version="v2")

    with pytest.raises(BaselineComparisonError, match="dataset ID and version"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_different_case_coverage() -> None:
    baseline = make_run(case_id="case-1")
    candidate = make_run(case_id="case-2")

    with pytest.raises(BaselineComparisonError, match="case coverage"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_different_evaluation_version() -> None:
    baseline = make_run(evaluation_version="evaluation-v1")
    candidate = make_run(evaluation_version="evaluation-v2")

    with pytest.raises(BaselineComparisonError, match="evaluation version"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_different_repetition_coverage() -> None:
    baseline = make_run(repetitions=1)
    candidate = make_run(repetitions=2)

    with pytest.raises(BaselineComparisonError, match="trial coverage"):
        compare_runs(baseline, candidate)


@pytest.mark.parametrize(
    ("changed_key", "changed_value"),
    [
        ("judge_model", "judge-v2"),
        ("judge_embedding_model", "embedding-v2"),
        ("judge_max_tokens", "2048"),
    ],
)
def test_comparison_rejects_changed_judge_configuration(
    changed_key: str,
    changed_value: str,
) -> None:
    baseline = make_run()
    candidate_versions = dict(make_sample().versions)
    candidate_versions[changed_key] = changed_value
    candidate = make_run(sample_versions=candidate_versions)

    with pytest.raises(BaselineComparisonError, match="judge configuration"):
        compare_runs(baseline, candidate)


def test_comparison_allows_answer_model_and_prompt_changes() -> None:
    baseline = make_run()
    candidate_versions = dict(make_sample().versions)
    candidate_versions.update(answer_model="answer-v2", answer_prompt="prompt-v2")
    candidate = make_run(sample_versions=candidate_versions)

    comparison = compare_runs(baseline, candidate)

    assert comparison.system_error_regressions == []
    assert comparison.system_error_recoveries == []


def test_comparison_rejects_missing_baseline_blocking_grader() -> None:
    baseline = make_run(grades=[make_grade()])
    candidate = make_run(grades=[make_grade(name="different-grader", blocking=False)])

    with pytest.raises(BaselineComparisonError, match="grade-key coverage"):
        compare_runs(baseline, candidate)


@pytest.mark.parametrize("blocking", [True, False])
def test_comparison_rejects_grader_version_change(blocking: bool) -> None:
    baseline = make_run(grades=[make_grade(version="v1", blocking=blocking)])
    candidate = make_run(grades=[make_grade(version="v2", blocking=blocking)])

    with pytest.raises(BaselineComparisonError, match="grade-key coverage"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_unmatched_candidate_grader() -> None:
    baseline = make_run(grades=[make_grade()])
    candidate = make_run(
        grades=[
            make_grade(),
            make_grade(
                name="answer-correctness",
                score=0.9,
                blocking=False,
            ),
        ]
    )

    with pytest.raises(BaselineComparisonError, match="grade-key coverage"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_promotion_of_same_grader_to_blocking() -> None:
    baseline = make_run(grades=[make_grade(score=0.0, passed=False, blocking=False)])
    candidate = make_run(grades=[make_grade(score=0.0, passed=False, blocking=True)])

    with pytest.raises(BaselineComparisonError, match="blocking classification"):
        compare_runs(baseline, candidate)


def test_comparison_rejects_demotion_of_same_grader_from_blocking() -> None:
    baseline = make_run(grades=[make_grade(score=0.0, passed=False, blocking=True)])
    candidate = make_run(grades=[make_grade(score=0.0, passed=False, blocking=False)])

    with pytest.raises(BaselineComparisonError, match="blocking classification"):
        compare_runs(baseline, candidate)


def test_comparison_reports_newly_failing_blocking_grade() -> None:
    baseline = make_run(grades=[make_grade()])
    candidate = make_run(grades=[make_grade(score=0.0, passed=False)])

    comparison = compare_runs(baseline, candidate)

    assert len(comparison.blocking_regressions) == 1
    regression = comparison.blocking_regressions[0]
    assert (
        regression.case_id,
        regression.repetition,
        regression.grader_name,
        regression.grader_version,
    ) == ("case-1", 1, "required-final-state", "v1")
    assert comparison.semantic_score_deltas == []


def test_comparison_reports_nonblocking_score_change_without_release_gate() -> None:
    baseline = make_run(
        grades=[
            make_grade(
                name="answer-correctness",
                score=0.9,
                blocking=False,
            )
        ]
    )
    candidate = make_run(
        grades=[
            make_grade(
                name="answer-correctness",
                score=0.4,
                passed=False,
                blocking=False,
            )
        ]
    )

    comparison = compare_runs(baseline, candidate)

    assert comparison.blocking_regressions == []
    assert len(comparison.semantic_score_deltas) == 1
    delta = comparison.semantic_score_deltas[0]
    assert (
        delta.case_id,
        delta.repetition,
        delta.grader_name,
        delta.grader_version,
    ) == ("case-1", 1, "answer-correctness", "v1")
    assert delta.baseline_score == 0.9
    assert delta.candidate_score == 0.4
    assert delta.delta == pytest.approx(-0.5)


def test_comparison_reports_completed_to_system_error_without_grade_mismatch() -> None:
    comparison = compare_runs(make_run(), make_run(system_error=True))

    assert len(comparison.system_error_regressions) == 1
    regression = comparison.system_error_regressions[0]
    assert (regression.case_id, regression.repetition) == ("case-1", 1)
    assert regression.error_message == "RuntimeError: provider unavailable"
    assert comparison.blocking_regressions == []
    assert comparison.semantic_score_deltas == []


def test_comparison_reports_system_error_recovery_without_grade_mismatch() -> None:
    comparison = compare_runs(make_run(system_error=True), make_run())

    assert len(comparison.system_error_recoveries) == 1
    recovery = comparison.system_error_recoveries[0]
    assert (recovery.case_id, recovery.repetition) == ("case-1", 1)
