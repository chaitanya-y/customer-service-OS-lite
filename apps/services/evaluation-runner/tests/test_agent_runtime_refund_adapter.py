import asyncio
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.agent_runtime_refund import (
    AgentRuntimeRefundAdapterError,
    AgentRuntimeRefundEvaluatedSystem,
    RefundAgentCaseInput,
)
from evaluation_runner.models import EvaluationDataset, TraceEventKind

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-agent-v1.json"
)


def load_case(case_id: str):
    dataset = EvaluationDataset.model_validate_json(DATASET_PATH.read_text())
    return next(case for case in dataset.cases if case.case_id == case_id)


def test_adapter_runs_the_real_graph_with_ordered_trace_and_deterministic_dependencies() -> (
    None
):
    clock_values = iter([10.0, 10.025])
    sample = asyncio.run(
        AgentRuntimeRefundEvaluatedSystem(clock=lambda: next(clock_values)).run(
            load_case("damaged-item-proposal-ready-v1"), repetition=1
        )
    )

    assert sample.final_state["status"] == "refund_proposal_ready"
    assert sample.final_state["tenant_id"] == "tenant-local"
    assert sample.final_state["environment_id"] == "local"
    assert sample.output["refund_proposal"]["intent"] == {
        "order_id": "eval-order-007",
        "reason_code": "DAMAGED",
        "scope": "FULL_ORDER",
        "item_ids": [],
        "requested_amount": {"amount_minor": 12000, "currency": "USD"},
    }
    assert [(event.kind, event.name) for event in sample.trace] == [
        (TraceEventKind.STATE_CHANGE, "initialize_request"),
        (TraceEventKind.STATE_CHANGE, "record_order_reference"),
        (TraceEventKind.TOOL_CALL, "lookup_order"),
        (TraceEventKind.STATE_CHANGE, "lookup_order"),
        (TraceEventKind.MODEL_CALL, "extract_refund_intent"),
        (TraceEventKind.STATE_CHANGE, "extract_refund_intent"),
        (TraceEventKind.RETRIEVAL, "retrieve_customer_evidence"),
        (TraceEventKind.STATE_CHANGE, "retrieve_customer_evidence"),
        (TraceEventKind.STATE_CHANGE, "build_refund_proposal"),
        (TraceEventKind.MODEL_CALL, "compose_customer_answer"),
        (TraceEventKind.STATE_CHANGE, "compose_customer_answer"),
    ]
    lookup = next(event for event in sample.trace if event.name == "lookup_order")
    assert lookup.payload == {
        "arguments": {"order_reference": "EVAL-ORDER-007"},
        "trusted_context": {
            "tenant_id": "tenant-local",
            "environment_id": "local",
            "source": "evaluation_fixture",
        },
        "outcome": "success",
    }
    assert sample.latency_ms == pytest.approx(25.0)
    assert sample.versions == {
        "adapter": "agent-runtime-refund-adapter-v1",
        "graph": "build_refund_graph",
        "dependency_mode": "deterministic-synthetic",
    }


def test_adapter_preserves_padded_input_until_the_graph_normalizes_the_lookup() -> None:
    case = load_case("order-lookup-success-v1")
    parsed_input = RefundAgentCaseInput.model_validate(case.input)

    assert parsed_input.order_reference == "  EVAL-ORDER-002  "

    sample = asyncio.run(AgentRuntimeRefundEvaluatedSystem().run(case, repetition=1))
    lookup = next(event for event in sample.trace if event.name == "lookup_order")
    assert lookup.payload == {
        "arguments": {"order_reference": "EVAL-ORDER-002"},
        "trusted_context": {
            "tenant_id": "tenant-local",
            "environment_id": "local",
            "source": "evaluation_fixture",
        },
        "outcome": "success",
    }


def test_adapter_rejects_whitespace_only_order_reference_without_normalizing_input() -> (
    None
):
    source_case = load_case("order-lookup-success-v1")
    case = source_case.model_copy(
        update={"input": {**source_case.input, "order_reference": "   "}}
    )

    with pytest.raises(AgentRuntimeRefundAdapterError, match="order_reference"):
        asyncio.run(AgentRuntimeRefundEvaluatedSystem().run(case, repetition=1))


def test_adapter_retains_caller_managed_history_and_previous_order_reference() -> None:
    sample = asyncio.run(
        AgentRuntimeRefundEvaluatedSystem().run(
            load_case("retained-order-reference-multiturn-v1"), repetition=1
        )
    )

    lookup_arguments = [
        event.payload["arguments"]["order_reference"]
        for event in sample.trace
        if event.kind is TraceEventKind.TOOL_CALL and event.name == "lookup_order"
    ]
    intent_call = [
        event
        for event in sample.trace
        if event.kind is TraceEventKind.MODEL_CALL
        and event.name == "extract_refund_intent"
    ][-1]
    assert lookup_arguments == ["EVAL-ORDER-006", "EVAL-ORDER-006"]
    assert intent_call.payload["conversation_messages"] == [
        {"sequence_number": 1, "text": "My order reference is EVAL-ORDER-006."},
        {
            "sequence_number": 2,
            "text": "It arrived damaged and I need a full refund.",
        },
    ]
    assert sample.final_state["order_reference"] == "EVAL-ORDER-006"


def test_adapter_rejects_more_than_eight_caller_managed_history_messages() -> None:
    case = load_case("damaged-item-proposal-ready-v1").model_copy(
        update={
            "input": {
                **load_case("damaged-item-proposal-ready-v1").input,
                "conversation_messages": [
                    {"sequence_number": number, "text": f"synthetic message {number}"}
                    for number in range(1, 10)
                ],
            }
        }
    )

    with pytest.raises(AgentRuntimeRefundAdapterError, match="conversation"):
        asyncio.run(AgentRuntimeRefundEvaluatedSystem().run(case, repetition=1))
