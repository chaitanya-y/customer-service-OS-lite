from __future__ import annotations

import math
from collections.abc import Mapping
from enum import StrEnum
from typing import Protocol

from .models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    GraderResult,
)


class RagasGraderError(ValueError):
    """Raised when semantic grading inputs or outputs are untrustworthy."""


class RagasMetricName(StrEnum):
    CONTEXT_PRECISION = "context_precision"
    CONTEXT_RECALL = "context_recall"
    FAITHFULNESS = "faithfulness"
    RESPONSE_RELEVANCY = "response_relevancy"
    FACTUAL_CORRECTNESS = "factual_correctness"


class RagasMetricScorer(Protocol):
    """The small RAGAS scoring capability required by one grader."""

    async def score(
        self,
        metric: RagasMetricName,
        **inputs: object,
    ) -> float:
        """Return one normalized semantic score."""


class RagasCollectionMetric(Protocol):
    """The stable portion of the RAGAS 0.4 collections metric API."""

    async def ascore(self, **inputs: object) -> object:
        """Score one case and return a RAGAS MetricResult-like object."""


class RagasCollectionsScorer:
    """Call an explicitly configured RAGAS collections metric."""

    def __init__(
        self,
        *,
        metrics: Mapping[RagasMetricName, RagasCollectionMetric],
    ) -> None:
        self._metrics = dict(metrics)

    async def score(
        self,
        metric: RagasMetricName,
        **inputs: object,
    ) -> float:
        configured_metric = self._metrics.get(metric)
        if configured_metric is None:
            raise RagasGraderError(f"RAGAS metric {metric.value!r} is not configured.")

        result = await configured_metric.ascore(**inputs)
        value = getattr(result, "value", None)
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise RagasGraderError(
                "RAGAS collections result must contain a numeric value."
            )
        return float(value)


def create_ragas_collections_scorer(
    *,
    llm: object,
    embeddings: object,
) -> RagasCollectionsScorer:
    """Construct the approved RAGAS 0.4 metrics with explicit model clients."""
    metric_types = _load_ragas_metric_types()
    configured_metrics = {}
    for metric in RagasMetricName:
        settings = {"llm": llm}
        if metric is RagasMetricName.RESPONSE_RELEVANCY:
            settings["embeddings"] = embeddings
        if metric is RagasMetricName.FACTUAL_CORRECTNESS:
            # Check stated claims without requiring every available fact to be said.
            settings["mode"] = "precision"
        configured_metrics[metric] = metric_types[metric](**settings)
    return RagasCollectionsScorer(metrics=configured_metrics)


def _load_ragas_metric_types() -> dict[RagasMetricName, type]:
    try:
        from ragas.metrics.collections import (
            AnswerRelevancy,
            ContextPrecision,
            ContextRecall,
            FactualCorrectness,
            Faithfulness,
        )
    except ImportError as error:
        raise RagasGraderError(
            "RAGAS is not installed. Sync Evaluation Runner with the ragas extra."
        ) from error

    return {
        RagasMetricName.CONTEXT_PRECISION: ContextPrecision,
        RagasMetricName.CONTEXT_RECALL: ContextRecall,
        RagasMetricName.FAITHFULNESS: Faithfulness,
        RagasMetricName.RESPONSE_RELEVANCY: AnswerRelevancy,
        RagasMetricName.FACTUAL_CORRECTNESS: FactualCorrectness,
    }


class RagasGrader:
    """Adapt one RAGAS semantic metric to the repository grader contract."""

    version = "ragas-0.4-adapter-v2"

    def __init__(
        self,
        *,
        metric: RagasMetricName,
        scorer: RagasMetricScorer,
        minimum: float,
        blocking: bool = False,
    ) -> None:
        self.metric = metric
        self.name = f"ragas-{metric.value.replace('_', '-')}"
        self._scorer = scorer
        self._minimum = _validate_unit_interval(
            minimum,
            message="minimum must be a number between 0 and 1",
        )
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        inputs = _metric_inputs(self.metric, case=case, sample=sample)
        score = _validate_unit_interval(
            await self._scorer.score(self.metric, **inputs),
            message="RAGAS score must be between 0 and 1",
            error_type=RagasGraderError,
        )
        passed = score >= self._minimum
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=score,
            passed=passed,
            blocking=self._blocking,
            reasons=(
                []
                if passed
                else [
                    (
                        f"RAGAS {self.metric.value.replace('_', ' ')} score "
                        f"{score:.4f} is below the configured minimum "
                        f"{self._minimum:.4f}."
                    )
                ]
            ),
            details={
                "minimum": self._minimum,
                "observed": score,
                "metric": self.metric.value,
                **(
                    {"mode": "precision"}
                    if self.metric is RagasMetricName.FACTUAL_CORRECTNESS
                    else {}
                ),
            },
        )


def _metric_inputs(
    metric: RagasMetricName,
    *,
    case: EvaluationCase,
    sample: EvaluationSample,
) -> dict[str, object]:
    if case.capability is not EvaluationCapability.ANSWER:
        raise RagasGraderError("RAGAS requires an ANSWER evaluation case")

    user_input = _required_string(case.input, "user_input", owner="case input")
    reference = _required_string(
        case.expectations,
        "reference",
        owner="case expectations",
    )
    response = _required_string(sample.output, "response", owner="sample output")
    retrieved_contexts = _required_string_list(
        sample.output,
        "retrieved_contexts",
        owner="sample output",
    )

    if metric in {
        RagasMetricName.CONTEXT_PRECISION,
        RagasMetricName.CONTEXT_RECALL,
    }:
        return {
            "user_input": user_input,
            "retrieved_contexts": retrieved_contexts,
            "reference": reference,
        }
    if metric is RagasMetricName.FAITHFULNESS:
        application_context = _application_context(sample)
        return {
            "user_input": user_input,
            "response": response,
            "retrieved_contexts": [
                *retrieved_contexts,
                *([application_context] if application_context else []),
            ],
        }
    if metric is RagasMetricName.RESPONSE_RELEVANCY:
        return {"user_input": user_input, "response": response}
    if metric is RagasMetricName.FACTUAL_CORRECTNESS:
        application_context = _application_context(sample)
        if application_context:
            reference = f"{reference}\n\n{application_context}"
        return {"response": response, "reference": reference}

    raise RagasGraderError(f"Unsupported RAGAS metric: {metric!r}")


def _application_context(sample: EvaluationSample) -> str:
    facts = sample.output.get("application_facts", [])
    if not isinstance(facts, list) or any(
        not isinstance(fact, str) or not fact.strip() for fact in facts
    ):
        raise RagasGraderError("application_facts must be a list of non-blank strings")
    if not facts:
        return ""
    return "Trusted application facts (not retrieved knowledge):\n" + "\n".join(facts)


def _required_string(values: dict, key: str, *, owner: str) -> str:
    value = values.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RagasGraderError(f"{owner} {key} must be a non-empty string")
    return value


def _required_string_list(values: dict, key: str, *, owner: str) -> list[str]:
    value = values.get(key)
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item.strip() for item in value)
    ):
        raise RagasGraderError(f"{owner} {key} must be a non-empty list of strings")
    return value


def _validate_unit_interval(
    value: object,
    *,
    message: str,
    error_type: type[ValueError] = ValueError,
) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or not math.isfinite(value)
        or not 0 <= value <= 1
    ):
        raise error_type(message)
    return float(value)
