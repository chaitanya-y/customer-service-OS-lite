from __future__ import annotations

from collections.abc import Sequence

from .models import (
    CaseSummary,
    EvaluationCase,
    EvaluationDataset,
    EvaluationRun,
    EvaluationSample,
    GraderResult,
    RunSummary,
    TrialResult,
    TrialStatus,
)
from .protocols import EvaluatedSystem, Grader


class EvaluationRunError(RuntimeError):
    """Raised when the evaluation process itself is invalid or unreliable."""


async def run_evaluation(
    *,
    dataset: EvaluationDataset,
    system: EvaluatedSystem,
    graders: Sequence[Grader],
    repetitions: int,
    run_id: str,
    evaluation_version: str,
) -> EvaluationRun:
    """Run every dataset case and preserve each trial's evidence and grades."""

    _validate_run_configuration(
        graders=graders,
        repetitions=repetitions,
        run_id=run_id,
        evaluation_version=evaluation_version,
    )

    trials: list[TrialResult] = []
    for case in dataset.cases:
        for repetition in range(1, repetitions + 1):
            trial_id = f"{run_id}:{case.case_id}:{repetition}"
            try:
                sample = await system.run(case, repetition=repetition)
            except Exception as exc:  # noqa: BLE001 - system failures are test outcomes
                trials.append(
                    TrialResult(
                        trial_id=trial_id,
                        case_id=case.case_id,
                        repetition=repetition,
                        status=TrialStatus.SYSTEM_ERROR,
                        passed=False,
                        error_message=f"{type(exc).__name__}: {exc}",
                        grader_results=[],
                    )
                )
                continue

            grader_results = await _grade_sample(
                graders=graders,
                case=case,
                sample=sample,
                repetition=repetition,
            )
            trials.append(
                TrialResult(
                    trial_id=trial_id,
                    case_id=case.case_id,
                    repetition=repetition,
                    status=TrialStatus.COMPLETED,
                    passed=all(
                        result.passed for result in grader_results if result.blocking
                    ),
                    sample=sample,
                    grader_results=grader_results,
                )
            )

    case_summaries = _summarize_cases(dataset, trials)
    return EvaluationRun(
        run_id=run_id,
        evaluation_version=evaluation_version,
        dataset_id=dataset.dataset_id,
        dataset_version=dataset.dataset_version,
        repetitions=repetitions,
        trials=trials,
        case_summaries=case_summaries,
        summary=_summarize_run(trials, case_summaries),
    )


async def _grade_sample(
    *,
    graders: Sequence[Grader],
    case: EvaluationCase,
    sample: EvaluationSample,
    repetition: int,
) -> list[GraderResult]:
    results: list[GraderResult] = []
    for grader in graders:
        try:
            result = await grader.grade(case, sample)
        except Exception as exc:
            raise EvaluationRunError(
                f"Grader {grader.name!r} failed for {case.case_id!r} "
                f"at repetition {repetition}: {type(exc).__name__}: {exc}"
            ) from exc

        expected_identity = (grader.name, grader.version)
        returned_identity = (result.grader_name, result.grader_version)
        if returned_identity != expected_identity:
            raise EvaluationRunError(
                f"Grader {grader.name!r} returned mismatched identity "
                f"{returned_identity!r}; expected {expected_identity!r}."
            )
        results.append(result)
    return results


def _validate_run_configuration(
    *,
    graders: Sequence[Grader],
    repetitions: int,
    run_id: str,
    evaluation_version: str,
) -> None:
    if repetitions < 1:
        raise EvaluationRunError("repetitions must be at least 1")
    if not run_id.strip():
        raise EvaluationRunError("run_id must not be blank")
    if not evaluation_version.strip():
        raise EvaluationRunError("evaluation_version must not be blank")
    if not graders:
        raise EvaluationRunError("at least one grader is required")

    identities = [(grader.name, grader.version) for grader in graders]
    if len(identities) != len(set(identities)):
        raise EvaluationRunError("grader name and version pairs must be unique")


def _summarize_cases(
    dataset: EvaluationDataset,
    trials: Sequence[TrialResult],
) -> list[CaseSummary]:
    summaries: list[CaseSummary] = []
    for case in dataset.cases:
        case_trials = [trial for trial in trials if trial.case_id == case.case_id]
        passed_count = sum(trial.passed for trial in case_trials)
        summaries.append(
            CaseSummary(
                case_id=case.case_id,
                trial_count=len(case_trials),
                passed_trial_count=passed_count,
                pass_rate=passed_count / len(case_trials),
                all_trials_passed=passed_count == len(case_trials),
            )
        )
    return summaries


def _summarize_run(
    trials: Sequence[TrialResult],
    case_summaries: Sequence[CaseSummary],
) -> RunSummary:
    passed_trial_count = sum(trial.passed for trial in trials)
    consistent_case_count = sum(summary.all_trials_passed for summary in case_summaries)
    return RunSummary(
        trial_count=len(trials),
        passed_trial_count=passed_trial_count,
        pass_rate=passed_trial_count / len(trials),
        case_count=len(case_summaries),
        consistent_case_count=consistent_case_count,
        consistent_case_rate=consistent_case_count / len(case_summaries),
    )
