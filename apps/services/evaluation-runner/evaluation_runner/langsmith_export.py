"""Offline, framework-neutral preparation of content-minimized LangSmith records."""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import EvaluationRun, RunSummary, TrialStatus

_SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PROMPT_VERSION_KEYS = ("answer_prompt", "prompt_bundle_version")
_MODEL_ROUTE_VERSION_KEYS = ("model_route_id", "model_route_version")


class GraderVersion(BaseModel):
    """One grader identity without reasons, inputs, or per-case output."""

    model_config = ConfigDict(frozen=True)

    grader_name: str = Field(min_length=1, max_length=128)
    grader_version: str = Field(min_length=1, max_length=128)


class GraderMetricSummary(BaseModel):
    """Aggregate, content-free results for a grader identity."""

    model_config = ConfigDict(frozen=True)

    grader_name: str = Field(min_length=1, max_length=128)
    grader_version: str = Field(min_length=1, max_length=128)
    trial_count: int = Field(gt=0)
    passed_trial_count: int = Field(ge=0)
    mean_score: float = Field(ge=0, le=1)
    blocking: bool


class LangSmithExportRecord(BaseModel):
    """The only evaluation data eligible for a future, separately approved export."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["langsmith-evaluation-export-v1"] = (
        "langsmith-evaluation-export-v1"
    )
    run_id: str = Field(min_length=1, max_length=128)
    dataset_id: str = Field(min_length=1, max_length=128)
    dataset_version: str = Field(min_length=1, max_length=128)
    evaluation_version: str = Field(min_length=1, max_length=128)
    prompt_versions: list[str]
    model_route_versions: list[str]
    grader_versions: list[GraderVersion]
    summary: RunSummary
    grader_metrics: list[GraderMetricSummary]


class LangSmithExportAdapter:
    """Build an offline record; this adapter never imports or calls LangSmith."""

    def build(
        self,
        run: EvaluationRun,
        *,
        enabled: bool = False,
    ) -> LangSmithExportRecord | None:
        if not enabled:
            return None

        return LangSmithExportRecord(
            run_id=_safe_value(run.run_id, "run_id"),
            dataset_id=_safe_value(run.dataset_id, "dataset_id"),
            dataset_version=_safe_value(run.dataset_version, "dataset_version"),
            evaluation_version=_safe_value(
                run.evaluation_version, "evaluation_version"
            ),
            prompt_versions=_allowlisted_versions(run, _PROMPT_VERSION_KEYS),
            model_route_versions=_allowlisted_versions(
                run, _MODEL_ROUTE_VERSION_KEYS
            ),
            grader_versions=_grader_versions(run),
            summary=run.summary,
            grader_metrics=_grader_metrics(run),
        )


def build_langsmith_export_record(
    run: EvaluationRun,
    *,
    enabled: bool = False,
) -> LangSmithExportRecord | None:
    """Prepare a record only when a caller explicitly enables export preparation."""

    return LangSmithExportAdapter().build(run, enabled=enabled)


def _safe_value(value: str, field_name: str) -> str:
    if not _SAFE_VERSION.fullmatch(value):
        raise ValueError(f"{field_name} must be a bounded version or identifier")
    return value


def _allowlisted_versions(run: EvaluationRun, keys: tuple[str, ...]) -> list[str]:
    values: set[str] = set()
    for trial in run.trials:
        if trial.status is not TrialStatus.COMPLETED or trial.sample is None:
            continue
        for key in keys:
            value = trial.sample.versions.get(key)
            if value is not None:
                values.add(_safe_value(value, key))
    return sorted(values)


def _grader_versions(run: EvaluationRun) -> list[GraderVersion]:
    identities = {
        (_safe_value(result.grader_name, "grader_name"), _safe_value(result.grader_version, "grader_version"))
        for trial in run.trials
        for result in trial.grader_results
    }
    return [
        GraderVersion(grader_name=name, grader_version=version)
        for name, version in sorted(identities)
    ]


def _grader_metrics(run: EvaluationRun) -> list[GraderMetricSummary]:
    grades: dict[tuple[str, str, bool], list[tuple[float, bool]]] = defaultdict(list)
    for trial in run.trials:
        if trial.status is not TrialStatus.COMPLETED:
            continue
        for result in trial.grader_results:
            key = (
                _safe_value(result.grader_name, "grader_name"),
                _safe_value(result.grader_version, "grader_version"),
                result.blocking,
            )
            grades[key].append((result.score, result.passed))

    return [
        GraderMetricSummary(
            grader_name=name,
            grader_version=version,
            blocking=blocking,
            trial_count=len(results),
            passed_trial_count=sum(passed for _, passed in results),
            mean_score=sum(score for score, _ in results) / len(results),
        )
        for (name, version, blocking), results in sorted(grades.items())
    ]
