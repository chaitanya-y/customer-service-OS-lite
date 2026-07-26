from typing import Literal

from langgraph.graph import END, START, StateGraph

from agent_runtime.refund.state import RefundState


def initialize_refund_request(state: RefundState) -> RefundState:
    customer_message = state.get("customer_message", "").strip()

    if not customer_message:
        raise ValueError("customer_message is required")

    return {
        "customer_message": customer_message,
        "journey": "refund",
        "status": "request_received",
    }


def route_order_reference(
    state: RefundState,
) -> Literal["present", "missing"]:
    order_reference = state.get("order_reference")

    if order_reference and order_reference.strip():
        return "present"

    return "missing"


def record_order_reference(state: RefundState) -> RefundState:
    order_reference = state.get("order_reference")

    if not order_reference:
        raise ValueError("order_reference is required")

    return {
        "order_reference": order_reference.strip(),
        "status": "order_reference_received",
    }


def request_order_reference(_: RefundState) -> RefundState:
    return {
        "order_reference": None,
        "status": "awaiting_order_reference",
    }


def build_refund_graph():
    builder = StateGraph(RefundState)

    builder.add_node("initialize_request", initialize_refund_request)
    builder.add_node("record_order_reference", record_order_reference)
    builder.add_node("request_order_reference", request_order_reference)

    builder.add_edge(START, "initialize_request")

    builder.add_conditional_edges(
        "initialize_request",
        route_order_reference,
        {
            "present": "record_order_reference",
            "missing": "request_order_reference",
        },
    )

    builder.add_edge("record_order_reference", END)
    builder.add_edge("request_order_reference", END)

    return builder.compile()


refund_graph = build_refund_graph()