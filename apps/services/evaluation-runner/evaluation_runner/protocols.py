from __future__ import annotations

from typing import Protocol

from .models import EvaluationCase, EvaluationSample, GraderResult


class EvaluatedSystem(Protocol):
    """A RAG, agent, or sandbox adapter that can execute one trial."""

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        """Execute one isolated attempt and return its observations."""


class Grader(Protocol):
    """A versioned deterministic or semantic evaluation criterion."""

    name: str
    version: str

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        """Grade one completed sample against the reviewed case."""
