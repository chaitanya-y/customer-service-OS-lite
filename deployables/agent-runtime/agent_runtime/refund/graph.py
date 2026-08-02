from typing import Literal

from langgraph.graph import END, START, StateGraph

from agent_runtime.integrations.order_lookup import (
    OrderLookup,
    OrderLookupError,
    OrderLookupUnauthorizedError,
    OrderNotFoundError,
)
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


def create_lookup_order_node(order_lookup: OrderLookup):
    async def lookup_order(state: RefundState) -> RefundState:
        order_reference = state.get("order_reference")

        if not order_reference:
            raise ValueError("order_reference is required")

        try:
            order_context = await order_lookup.lookup_order(order_reference)
        except OrderLookupUnauthorizedError:
            raise
        except OrderNotFoundError as error:
            return {
                "order_context": None,
                "error_code": error.code,
                "status": "order_not_found",
            }
        except OrderLookupError as error:
            return {
                "order_context": None,
                "error_code": error.code,
                "status": "order_lookup_unavailable",
            }

        return {
            "order_context": order_context,
            "error_code": None,
            "status": "order_context_loaded",
        }

    return lookup_order


def build_refund_graph(order_lookup: OrderLookup):
    builder = StateGraph(RefundState)

    builder.add_node("initialize_request", initialize_refund_request)
    builder.add_node("record_order_reference", record_order_reference)
    builder.add_node("request_order_reference", request_order_reference)
    builder.add_node(
        "lookup_order",
        create_lookup_order_node(order_lookup),
    )

    builder.add_edge(START, "initialize_request")

    builder.add_conditional_edges(
        "initialize_request",
        route_order_reference,
        {
            "present": "record_order_reference",
            "missing": "request_order_reference",
        },
    )

    builder.add_edge("record_order_reference", "lookup_order")
    builder.add_edge("lookup_order", END)
    builder.add_edge("request_order_reference", END)

    return builder.compile()
