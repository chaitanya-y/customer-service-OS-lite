import asyncio

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)
from evaluation_runner.trajectory_graders import (
    ProposalFieldsGrader,
    RequiredRouteStatusGrader,
    RequiredToolArgumentsGrader,
    RequiredToolsGrader,
)


def make_case(expectations: dict) -> EvaluationCase:
    return EvaluationCase(
        case_id="trajectory-v1",
        name="Trajectory",
        capability=EvaluationCapability.AGENT,
        input={"customer_message": "Refund this synthetic order."},
        expectations=expectations,
    )


def make_sample(
    *, output: dict | None = None, trace: list[TraceEvent] | None = None
) -> EvaluationSample:
    return EvaluationSample(
        output=output or {"status": "refund_proposal_ready"},
        final_state={"status": "refund_proposal_ready"},
        trace=trace or [],
        latency_ms=1,
        versions={"adapter": "test"},
    )


def test_required_route_status_grader_rejects_a_wrong_final_route() -> None:
    result = asyncio.run(
        RequiredRouteStatusGrader().grade(
            make_case({"required_route_status": "order_not_found"}),
            make_sample(),
        )
    )

    assert result.passed is False
    assert result.reasons == [
        "Route status expected 'order_not_found' but received 'refund_proposal_ready'."
    ]


def test_required_tools_grader_rejects_a_missing_lookup() -> None:
    result = asyncio.run(
        RequiredToolsGrader().grade(
            make_case({"required_tools": ["lookup_order"]}),
            make_sample(),
        )
    )

    assert result.passed is False
    assert result.reasons == ["Required tool was not called: lookup_order."]


def test_required_tool_arguments_grader_rejects_wrong_normalized_argument() -> None:
    result = asyncio.run(
        RequiredToolArgumentsGrader().grade(
            make_case(
                {
                    "reviewed_tool_arguments": {
                        "lookup_order": [{"order_reference": "EVAL-ORDER-1"}]
                    }
                }
            ),
            make_sample(
                trace=[
                    TraceEvent(
                        sequence=1,
                        kind=TraceEventKind.TOOL_CALL,
                        name="lookup_order",
                        payload={
                            "arguments": {"order_reference": "INVENTED-ORDER"},
                            "trusted_context": {
                                "tenant_id": "tenant-local",
                                "environment_id": "local",
                                "source": "evaluation_fixture",
                            },
                        },
                    )
                ]
            ),
        )
    )

    assert result.passed is False
    assert result.reasons == [
        "Tool 'lookup_order' arguments did not match reviewed arguments."
    ]


def test_required_tool_arguments_grader_uses_only_observed_protocol_arguments() -> None:
    result = asyncio.run(
        RequiredToolArgumentsGrader().grade(
            make_case(
                {
                    "reviewed_tool_arguments": {
                        "lookup_order": [{"order_reference": "EVAL-ORDER-1"}]
                    }
                }
            ),
            make_sample(
                trace=[
                    TraceEvent(
                        sequence=1,
                        kind=TraceEventKind.TOOL_CALL,
                        name="lookup_order",
                        payload={
                            "arguments": {"order_reference": "EVAL-ORDER-1"},
                            "trusted_context": {
                                "tenant_id": "tenant-local",
                                "environment_id": "local",
                                "source": "evaluation_fixture",
                            },
                        },
                    )
                ]
            ),
        )
    )

    assert result.passed is True


def test_proposal_fields_grader_rejects_a_wrong_amount() -> None:
    result = asyncio.run(
        ProposalFieldsGrader().grade(
            make_case(
                {"proposal_fields": {"intent.requested_amount.amount_minor": 12000}}
            ),
            make_sample(
                output={
                    "status": "refund_proposal_ready",
                    "refund_proposal": {
                        "intent": {"requested_amount": {"amount_minor": 99999}}
                    },
                }
            ),
        )
    )

    assert result.passed is False
    assert result.reasons == [
        "Proposal field 'intent.requested_amount.amount_minor' expected 12000 but received 99999."
    ]
