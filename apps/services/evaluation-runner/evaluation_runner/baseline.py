from __future__ import annotations

from dataclasses import dataclass

from .models import EvaluationRun, GraderResult, TrialResult, TrialStatus


class BaselineComparisonError(ValueError):
    """Raised when two evaluation runs are not comparable."""


@dataclass(frozen=True)
class BlockingGradeRegression:
    """A blocking grade that passed in the baseline and fails in the candidate."""

    case_id: str
    repetition: int
    grader_name: str
    grader_version: str


@dataclass(frozen=True)
class SemanticScoreDelta:
    """An informational score change for a non-blocking grader."""

    case_id: str
    repetition: int
    grader_name: str
    grader_version: str
    baseline_score: float
    candidate_score: float
    delta: float


@dataclass(frozen=True)
class SystemErrorChange:
    """A trial that newly failed at the system boundary or recovered from it."""

    case_id: str
    repetition: int
    error_message: str


@dataclass(frozen=True)
class RunComparison:
    """Separate blocking regressions from informational semantic score changes."""

    blocking_regressions: list[BlockingGradeRegression]
    semantic_score_deltas: list[SemanticScoreDelta]
    system_error_regressions: list[SystemErrorChange]
    system_error_recoveries: list[SystemErrorChange]


def compare_runs(
    baseline: EvaluationRun,
    candidate: EvaluationRun,
) -> RunComparison:
    """Compare compatible runs without making semantic score deltas release gates."""

    if (
        baseline.dataset_id != candidate.dataset_id
        or baseline.dataset_version != candidate.dataset_version
    ):
        raise BaselineComparisonError(
            "Baseline and candidate must have matching dataset ID and version."
        )
    if set(baseline.dataset_case_ids) != set(candidate.dataset_case_ids):
        raise BaselineComparisonError(
            "Baseline and candidate must have matching case coverage."
        )
    if baseline.evaluation_version != candidate.evaluation_version:
        raise BaselineComparisonError(
            "Baseline and candidate must have matching evaluation version."
        )

    baseline_trials = _index_trials(baseline)
    candidate_trials = _index_trials(candidate)
    if baseline_trials.keys() != candidate_trials.keys():
        raise BaselineComparisonError(
            "Baseline and candidate must have matching trial coverage."
        )
    system_error_regressions: list[SystemErrorChange] = []
    system_error_recoveries: list[SystemErrorChange] = []
    comparable_trial_keys: set[tuple[str, int]] = set()
    for key in sorted(baseline_trials):
        baseline_trial = baseline_trials[key]
        candidate_trial = candidate_trials[key]
        if (
            baseline_trial.status is TrialStatus.COMPLETED
            and candidate_trial.status is TrialStatus.SYSTEM_ERROR
        ):
            system_error_regressions.append(
                SystemErrorChange(
                    case_id=key[0],
                    repetition=key[1],
                    error_message=candidate_trial.error_message
                    or "Unknown system error",
                )
            )
        elif (
            baseline_trial.status is TrialStatus.SYSTEM_ERROR
            and candidate_trial.status is TrialStatus.COMPLETED
        ):
            system_error_recoveries.append(
                SystemErrorChange(
                    case_id=key[0],
                    repetition=key[1],
                    error_message=baseline_trial.error_message
                    or "Unknown system error",
                )
            )
        elif (
            baseline_trial.status is TrialStatus.COMPLETED
            and candidate_trial.status is TrialStatus.COMPLETED
        ):
            _validate_judge_configuration(baseline_trial, candidate_trial)
            comparable_trial_keys.add(key)

    baseline_grades = _index_grades(baseline, comparable_trial_keys)
    candidate_grades = _index_grades(candidate, comparable_trial_keys)
    if baseline_grades.keys() != candidate_grades.keys():
        raise BaselineComparisonError(
            "Baseline and candidate must have matching grade-key coverage."
        )
    if any(
        baseline_grades[key].blocking != candidate_grades[key].blocking
        for key in baseline_grades
    ):
        raise BaselineComparisonError(
            "Baseline and candidate graders must have matching blocking classification."
        )

    blocking_regressions: list[BlockingGradeRegression] = []
    semantic_score_deltas: list[SemanticScoreDelta] = []

    for key in sorted(baseline_grades.keys() & candidate_grades.keys()):
        baseline_grade = baseline_grades[key]
        candidate_grade = candidate_grades[key]
        case_id, repetition, grader_name, grader_version = key

        if (
            baseline_grade.blocking
            and baseline_grade.passed
            and candidate_grade.blocking
            and not candidate_grade.passed
        ):
            blocking_regressions.append(
                BlockingGradeRegression(
                    case_id=case_id,
                    repetition=repetition,
                    grader_name=grader_name,
                    grader_version=grader_version,
                )
            )
        elif (
            not baseline_grade.blocking
            and not candidate_grade.blocking
            and baseline_grade.score != candidate_grade.score
        ):
            semantic_score_deltas.append(
                SemanticScoreDelta(
                    case_id=case_id,
                    repetition=repetition,
                    grader_name=grader_name,
                    grader_version=grader_version,
                    baseline_score=baseline_grade.score,
                    candidate_score=candidate_grade.score,
                    delta=candidate_grade.score - baseline_grade.score,
                )
            )

    return RunComparison(
        blocking_regressions=blocking_regressions,
        semantic_score_deltas=semantic_score_deltas,
        system_error_regressions=system_error_regressions,
        system_error_recoveries=system_error_recoveries,
    )


def _index_grades(
    run: EvaluationRun,
    trial_keys: set[tuple[str, int]],
) -> dict[tuple[str, int, str, str], GraderResult]:
    return {
        (
            trial.case_id,
            trial.repetition,
            grader_result.grader_name,
            grader_result.grader_version,
        ): grader_result
        for trial in run.trials
        if (trial.case_id, trial.repetition) in trial_keys
        for grader_result in trial.grader_results
    }


def _index_trials(run: EvaluationRun) -> dict[tuple[str, int], TrialResult]:
    return {(trial.case_id, trial.repetition): trial for trial in run.trials}


def _validate_judge_configuration(
    baseline: TrialResult,
    candidate: TrialResult,
) -> None:
    assert baseline.sample is not None and candidate.sample is not None
    keys = ("judge_model", "judge_embedding_model", "judge_max_tokens")
    if any(
        baseline.sample.versions.get(key) != candidate.sample.versions.get(key)
        for key in keys
    ):
        raise BaselineComparisonError(
            "Baseline and candidate completed trials must have matching judge "
            "configuration."
        )
