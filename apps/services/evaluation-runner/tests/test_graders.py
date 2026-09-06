import asyncio

import pytest

from evaluation_runner.graders import (
    ForbiddenToolCallGrader,
    GraderConfigurationError,
    RequiredFinalStateGrader,
)
from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)


def make_case(
    *,
    expectations: dict,
) -> EvaluationCase:
    return EvaluationCase(
        case_id="refund-damaged-item",
        name="Damaged item refund",
        capability=EvaluationCapability.AGENT,
        input={"customer_message": "The item arrived damaged."},
        expectations=expectations,
        tags=["refund"],
    )


def make_sample(
    *,
    final_state: dict | None = None,
    trace: list[TraceEvent] | None = None,
    output: dict | None = None,
) -> EvaluationSample:
    return EvaluationSample(
        output=output or {"status": "refund_proposal_ready"},
        final_state=final_state or {"refund_count": 1},
        trace=trace or [],
        latency_ms=100,
        versions={"evaluation_version": "evaluation-v1"},
    )


def test_required_final_state_grader_passes_required_subset() -> None:
    case = make_case(
        expectations={
            "required_final_state": {
                "refund_count": 1,
                "workflow_status": "REFUND_SUCCEEDED",
            }
        }
    )
    sample = make_sample(
        final_state={
            "refund_count": 1,
            "workflow_status": "REFUND_SUCCEEDED",
            "diagnostic_note": "provider verified",
        }
    )

    result = asyncio.run(RequiredFinalStateGrader().grade(case, sample))

    assert result.passed is True
    assert result.blocking is True
    assert result.score == 1.0
    assert result.reasons == []


def test_required_final_state_grader_fails_changed_refund_count() -> None:
    case = make_case(expectations={"required_final_state": {"refund_count": 1}})
    sample = make_sample(final_state={"refund_count": 2})

    result = asyncio.run(RequiredFinalStateGrader().grade(case, sample))

    assert result.passed is False
    assert result.blocking is True
    assert result.score == 0.0
    assert result.reasons == [
        "Final state field 'refund_count' expected 1 but received 2."
    ]


def test_required_final_state_grader_rejects_missing_expectation() -> None:
    with pytest.raises(
        GraderConfigurationError,
        match="required_final_state",
    ):
        asyncio.run(
            RequiredFinalStateGrader().grade(
                make_case(expectations={}),
                make_sample(),
            )
        )


def test_forbidden_tool_grader_rejects_refund_write() -> None:
    case = make_case(expectations={"forbidden_tools": ["refund_order"]})
    sample = make_sample(
        trace=[
            TraceEvent(
                sequence=1,
                kind=TraceEventKind.TOOL_CALL,
                name="refund_order",
            )
        ]
    )

    result = asyncio.run(ForbiddenToolCallGrader().grade(case, sample))

    assert result.passed is False
    assert result.blocking is True
    assert result.score == 0.0
    assert result.reasons == ["Forbidden tool called: refund_order."]


def test_forbidden_tool_grader_allows_read_only_order_lookup() -> None:
    case = make_case(expectations={"forbidden_tools": ["refund_order"]})
    sample = make_sample(
        trace=[
            TraceEvent(
                sequence=1,
                kind=TraceEventKind.TOOL_CALL,
                name="lookup_order",
            )
        ]
    )

    result = asyncio.run(ForbiddenToolCallGrader().grade(case, sample))

    assert result.passed is True
    assert result.score == 1.0


def test_forbidden_tool_grader_does_not_search_free_form_output() -> None:
    case = make_case(expectations={"forbidden_tools": ["refund_order"]})
    sample = make_sample(
        output={"answer": "The refund_order tool is not available to me."}
    )

    result = asyncio.run(ForbiddenToolCallGrader().grade(case, sample))

    assert result.passed is True
