from __future__ import annotations

import math

from .models import EvaluationCase, EvaluationSample, GraderResult


class RetrievalGraderError(ValueError):
    """Raised when a retrieval sample lacks trustworthy grading evidence."""


class RecallAtKGrader:
    name = "retrieval-recall-at-k"
    version = "v1"

    def __init__(
        self,
        *,
        minimum: float,
        blocking: bool = False,
    ) -> None:
        self._minimum = _validate_minimum(minimum)
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        del case

        observed = _read_unit_interval_metric(sample, "recall_at_k")
        passed = observed >= self._minimum
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=observed,
            passed=passed,
            blocking=self._blocking,
            reasons=(
                []
                if passed
                else [
                    (
                        f"Recall at K {observed:.4f} is below the configured "
                        f"minimum {self._minimum:.4f}."
                    )
                ]
            ),
            details={
                "minimum": self._minimum,
                "observed": observed,
            },
        )


class ReciprocalRankGrader:
    name = "retrieval-reciprocal-rank"
    version = "v1"

    def __init__(
        self,
        *,
        minimum: float,
        blocking: bool = False,
    ) -> None:
        self._minimum = _validate_minimum(minimum)
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        del case

        observed = _read_unit_interval_metric(sample, "reciprocal_rank")
        passed = observed >= self._minimum
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=observed,
            passed=passed,
            blocking=self._blocking,
            reasons=(
                []
                if passed
                else [
                    (
                        f"Reciprocal rank {observed:.4f} is below the configured "
                        f"minimum {self._minimum:.4f}."
                    )
                ]
            ),
            details={
                "minimum": self._minimum,
                "observed": observed,
            },
        )


class ForbiddenEvidenceGrader:
    name = "retrieval-forbidden-evidence"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        del case

        count = _read_forbidden_evidence_count(sample)
        passed = count == 0
        noun = "item" if count == 1 else "items"
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=(
                [] if passed else [f"Retrieved {count} forbidden evidence {noun}."]
            ),
            details={"forbidden_evidence_count": count},
        )


def _validate_minimum(minimum: float) -> float:
    if (
        isinstance(minimum, bool)
        or not isinstance(minimum, int | float)
        or not math.isfinite(minimum)
        or not 0 <= minimum <= 1
    ):
        raise ValueError("minimum must be a number between 0 and 1")
    return float(minimum)


def _read_retrieval_metrics(sample: EvaluationSample) -> dict:
    metrics = sample.output.get("retrieval_metrics")
    if not isinstance(metrics, dict):
        raise RetrievalGraderError("retrieval_metrics must be an object")
    return metrics


def _read_unit_interval_metric(
    sample: EvaluationSample,
    name: str,
) -> float:
    value = _read_retrieval_metrics(sample).get(name)
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise RetrievalGraderError(f"{name} must be numeric")

    numeric_value = float(value)
    if not math.isfinite(numeric_value) or not 0 <= numeric_value <= 1:
        raise RetrievalGraderError(f"{name} must be between 0 and 1")
    return numeric_value


def _read_forbidden_evidence_count(sample: EvaluationSample) -> int:
    value = _read_retrieval_metrics(sample).get("forbidden_evidence_count")
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RetrievalGraderError(
            "forbidden_evidence_count must be a non-negative integer"
        )
    return value
