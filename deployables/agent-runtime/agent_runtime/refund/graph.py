from typing import Literal

from langgraph.graph import END, START, StateGraph

from agent_runtime.integrations.order_lookup import (
    OrderLookup,
    OrderLookupError,
    OrderLookupUnauthorizedError,
    OrderNotFoundError,
)
from agent_runtime.refund.intent import (
    RefundIntentExtractionError,
    RefundIntentExtractor,
)
from agent_runtime.refund.proposal import RefundProposalBuilder
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


def route_loaded_order(
    state: RefundState,
) -> Literal["extract_intent", "end"]:
    if state.get("status") == "order_context_loaded":
        return "extract_intent"

    return "end"


def create_extract_refund_intent_node(intent_extractor: RefundIntentExtractor):
    async def extract_refund_intent(state: RefundState) -> RefundState:
        customer_message = state.get("customer_message")
        order_context = state.get("order_context")

        if not customer_message or order_context is None:
            raise ValueError("customer_message and order_context are required")

        try:
            refund_intent = await intent_extractor.extract(
                customer_message=customer_message,
                order_context=order_context,
            )
        except RefundIntentExtractionError:
            return {
                "refund_intent": None,
                "refund_proposal": None,
                "error_code": "intent_extraction_unavailable",
                "status": "intent_extraction_unavailable",
            }

        return {
            "refund_intent": refund_intent,
            "error_code": None,
            "status": "refund_intent_extracted",
        }

    return extract_refund_intent


def route_extracted_intent(
    state: RefundState,
) -> Literal["build_proposal", "end"]:
    if state.get("status") == "refund_intent_extracted":
        return "build_proposal"

    return "end"


def create_build_refund_proposal_node(proposal_builder: RefundProposalBuilder):
    def build_refund_proposal(state: RefundState) -> RefundState:
        refund_intent = state.get("refund_intent")
        order_context = state.get("order_context")
        turn_id = state.get("turn_id")
        trace_id = state.get("trace_id")

        if (
            refund_intent is None
            or order_context is None
            or not turn_id
            or not trace_id
        ):
            raise ValueError(
                "refund intent, order context, and correlation IDs are required"
            )

        refund_proposal = proposal_builder.build(
            extraction=refund_intent,
            order_context=order_context,
            turn_id=turn_id,
            trace_id=trace_id,
        )

        return {
            "refund_proposal": refund_proposal,
            "status": (
                "awaiting_refund_details"
                if refund_proposal.missing_fields
                else "refund_proposal_ready"
            ),
        }

    return build_refund_proposal


def build_refund_graph(
    order_lookup: OrderLookup,
    intent_extractor: RefundIntentExtractor,
    proposal_builder: RefundProposalBuilder,
):
    builder = StateGraph(RefundState)

    builder.add_node("initialize_request", initialize_refund_request)
    builder.add_node("record_order_reference", record_order_reference)
    builder.add_node("request_order_reference", request_order_reference)
    builder.add_node(
        "lookup_order",
        create_lookup_order_node(order_lookup),
    )
    builder.add_node(
        "extract_refund_intent",
        create_extract_refund_intent_node(intent_extractor),
    )
    builder.add_node(
        "build_refund_proposal",
        create_build_refund_proposal_node(proposal_builder),
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
    builder.add_conditional_edges(
        "lookup_order",
        route_loaded_order,
        {
            "extract_intent": "extract_refund_intent",
            "end": END,
        },
    )
    builder.add_conditional_edges(
        "extract_refund_intent",
        route_extracted_intent,
        {
            "build_proposal": "build_refund_proposal",
            "end": END,
        },
    )
    builder.add_edge("build_refund_proposal", END)
    builder.add_edge("request_order_reference", END)

    return builder.compile()
