from __future__ import annotations

from typing import Any

from .models import EvaluationCase, EvaluationSample, GraderResult, TraceEventKind


class TrajectoryGraderConfigurationError(ValueError):
    """Raised when a reviewed trajectory expectation is malformed."""


class RequiredRouteStatusGrader:
    name = "required-route-status"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        expected = case.expectations.get("required_route_status")
        if not isinstance(expected, str) or not expected.strip():
            raise TrajectoryGraderConfigurationError(
                "required_route_status must be a non-blank string."
            )

        observed = sample.final_state.get("status")
        passed = observed == expected
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=(
                []
                if passed
                else [f"Route status expected {expected!r} but received {observed!r}."]
            ),
            details={"expected": expected, "observed": observed},
        )


class RequiredToolsGrader:
    name = "required-tools"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        required_tools = _read_tool_names(
            case.expectations.get("required_tools"),
            owner="required_tools",
        )
        called_tools = {
            event.name
            for event in sample.trace
            if event.kind is TraceEventKind.TOOL_CALL
        }
        missing = [tool for tool in required_tools if tool not in called_tools]
        passed = not missing
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=[f"Required tool was not called: {tool}." for tool in missing],
            details={
                "required_tools": required_tools,
                "called_tools": sorted(called_tools),
            },
        )


class RequiredToolArgumentsGrader:
    name = "reviewed-tool-arguments"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        reviewed = _read_reviewed_tool_arguments(
            case.expectations.get("reviewed_tool_arguments")
        )
        reasons: list[str] = []
        for tool_name, expected_calls in reviewed.items():
            observed_calls = [
                _read_observed_arguments(event.payload)
                for event in sample.trace
                if event.kind is TraceEventKind.TOOL_CALL and event.name == tool_name
            ]
            if len(observed_calls) != len(expected_calls) or any(
                not _is_subset(expected, observed)
                for expected, observed in zip(expected_calls, observed_calls)
            ):
                reasons.append(
                    f"Tool {tool_name!r} arguments did not match reviewed arguments."
                )

        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={"reviewed_tool_count": len(reviewed)},
        )


class ProposalFieldsGrader:
    name = "required-proposal-fields"
    version = "v1"

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        expected_fields = _read_proposal_fields(
            case.expectations.get("proposal_fields")
        )
        if not expected_fields:
            return GraderResult(
                grader_name=self.name,
                grader_version=self.version,
                score=1.0,
                passed=True,
                blocking=True,
                details={"required_field_count": 0},
            )

        proposal = sample.output.get("refund_proposal")
        reasons: list[str] = []
        for field_path, expected in expected_fields.items():
            observed = _read_path(proposal, field_path)
            if observed != expected:
                reasons.append(
                    f"Proposal field {field_path!r} expected {expected!r} but received {observed!r}."
                )

        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={"required_field_count": len(expected_fields)},
        )


def _read_tool_names(value: object, *, owner: str) -> list[str]:
    if not isinstance(value, list) or any(
        not isinstance(tool, str) or not tool.strip() for tool in value
    ):
        raise TrajectoryGraderConfigurationError(
            f"{owner} must be a list of non-blank tool names."
        )
    if len(value) != len(set(value)):
        raise TrajectoryGraderConfigurationError(
            f"{owner} must not contain duplicate tool names."
        )
    return value


def _read_reviewed_tool_arguments(value: object) -> dict[str, list[dict[str, Any]]]:
    if not isinstance(value, dict):
        raise TrajectoryGraderConfigurationError(
            "reviewed_tool_arguments must be an object."
        )

    normalized: dict[str, list[dict[str, Any]]] = {}
    for tool_name, calls in value.items():
        if not isinstance(tool_name, str) or not tool_name.strip():
            raise TrajectoryGraderConfigurationError(
                "reviewed_tool_arguments keys must be non-blank tool names."
            )
        if (
            not isinstance(calls, list)
            or not calls
            or any(
                not isinstance(arguments, dict) or not arguments for arguments in calls
            )
        ):
            raise TrajectoryGraderConfigurationError(
                "reviewed_tool_arguments values must be non-empty argument lists."
            )
        normalized[tool_name] = calls
    return normalized


def _read_proposal_fields(value: object) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict) or any(
        not isinstance(path, str) or not path.strip() for path in value
    ):
        raise TrajectoryGraderConfigurationError(
            "proposal_fields must be an object with non-blank dotted paths."
        )
    return value


def _is_subset(expected: dict[str, Any], observed: dict[str, Any]) -> bool:
    return all(observed.get(key) == value for key, value in expected.items())


def _read_observed_arguments(payload: dict[str, Any]) -> dict[str, Any]:
    arguments = payload.get("arguments")
    return arguments if isinstance(arguments, dict) else {}


def _read_path(value: object, path: str) -> object:
    current = value
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current
