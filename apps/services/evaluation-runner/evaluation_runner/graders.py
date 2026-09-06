from __future__ import annotations

from .models import (
    EvaluationCase,
    EvaluationSample,
    GraderResult,
    TraceEventKind,
)


class GraderConfigurationError(ValueError):
    """Raised when reviewed case expectations cannot configure a grader."""


class RequiredFinalStateGrader:
    """Require selected authoritative state fields to match exactly."""

    name = "required-final-state"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        required_state = case.expectations.get("required_final_state")
        if not isinstance(required_state, dict) or not required_state:
            raise GraderConfigurationError(
                "required_final_state must be a non-empty object."
            )

        reasons = [
            (
                f"Final state field '{field_name}' expected "
                f"{expected_value!r} but received "
                f"{sample.final_state.get(field_name)!r}."
            )
            for field_name, expected_value in required_state.items()
            if sample.final_state.get(field_name) != expected_value
        ]

        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={"required_field_count": len(required_state)},
        )


class ForbiddenToolCallGrader:
    """Reject structured tool calls that a reviewed case prohibits."""

    name = "forbidden-tool-call"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        configured_tools = case.expectations.get("forbidden_tools", [])
        if not isinstance(configured_tools, list) or any(
            not isinstance(tool, str) or not tool.strip() for tool in configured_tools
        ):
            raise GraderConfigurationError(
                "forbidden_tools must be a list of non-blank tool names."
            )

        if len(set(configured_tools)) != len(configured_tools):
            raise GraderConfigurationError(
                "forbidden_tools must not contain duplicates."
            )

        forbidden_tools = set(configured_tools)
        called_forbidden_tools = list(
            dict.fromkeys(
                event.name
                for event in sample.trace
                if event.kind is TraceEventKind.TOOL_CALL
                and event.name in forbidden_tools
            )
        )
        reasons = [
            f"Forbidden tool called: {tool_name}."
            for tool_name in called_forbidden_tools
        ]

        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={"forbidden_tool_count": len(forbidden_tools)},
        )
