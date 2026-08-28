from typing import Literal

from langgraph.graph import END, START, StateGraph

from agent_runtime.integrations.customer_evidence import (
    CustomerEvidenceLookup,
    CustomerEvidenceLookupError,
    CustomerEvidenceLookupUnauthorizedError,
)
from agent_runtime.integrations.order_lookup import (
    OrderLookup,
    OrderLookupError,
    OrderLookupUnauthorizedError,
    OrderNotFoundError,
)
from agent_runtime.refund.answer import (
    CustomerAnswer,
    RefundAnswerComposer,
    RefundAnswerCompositionError,
    build_fallback_customer_answer,
)
from agent_runtime.refund.intent import (
    RefundIntentExtractionError,
    RefundIntentExtractor,
)
from agent_runtime.refund.proposal import RefundProposalBuilder
from agent_runtime.refund.state import RefundState

MISSING_ORDER_REFERENCE_MESSAGE = (
    "Please share your order reference so I can look into this refund request."
)


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
        "customer_answer": CustomerAnswer(
            message=MISSING_ORDER_REFERENCE_MESSAGE,
        ),
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
) -> Literal["retrieve_customer_evidence", "end"]:
    if state.get("status") == "refund_intent_extracted":
        return "retrieve_customer_evidence"

    return "end"


def create_retrieve_customer_evidence_node(
    customer_evidence_lookup: CustomerEvidenceLookup,
):
    async def retrieve_customer_evidence(state: RefundState) -> RefundState:
        customer_message = state.get("customer_message")

        if not customer_message:
            raise ValueError("customer_message is required")

        try:
            response = await customer_evidence_lookup.retrieve_customer_evidence(
                customer_message
            )
        except CustomerEvidenceLookupUnauthorizedError:
            raise
        except CustomerEvidenceLookupError:
            return {
                "knowledge_evidence": [],
                "knowledge_retrieval_status": "unavailable",
            }

        return {
            "knowledge_evidence": response.evidence,
            "knowledge_retrieval_status": "retrieved",
        }

    return retrieve_customer_evidence


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


def create_compose_customer_answer_node(
    answer_composer: RefundAnswerComposer,
):
    async def compose_customer_answer(state: RefundState) -> RefundState:
        customer_message = state.get("customer_message")
        refund_proposal = state.get("refund_proposal")
        knowledge_evidence = state.get("knowledge_evidence", [])

        if not customer_message or refund_proposal is None:
            raise ValueError(
                "customer_message and refund_proposal are required"
            )

        if not knowledge_evidence:
            return {
                "customer_answer": build_fallback_customer_answer(
                    refund_proposal
                ),
                "answer_composition_status": "fallback",
            }

        try:
            answer = await answer_composer.compose(
                customer_message=customer_message,
                refund_proposal=refund_proposal,
                knowledge_evidence=knowledge_evidence,
            )
        except RefundAnswerCompositionError:
            return {
                "customer_answer": build_fallback_customer_answer(
                    refund_proposal
                ),
                "answer_composition_status": "fallback",
            }

        return {
            "customer_answer": answer,
            "answer_composition_status": "generated",
        }

    return compose_customer_answer


def build_refund_graph(
    order_lookup: OrderLookup,
    intent_extractor: RefundIntentExtractor,
    proposal_builder: RefundProposalBuilder,
    customer_evidence_lookup: CustomerEvidenceLookup,
    answer_composer: RefundAnswerComposer,
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
        "retrieve_customer_evidence",
        create_retrieve_customer_evidence_node(customer_evidence_lookup),
    )
    builder.add_node(
        "build_refund_proposal",
        create_build_refund_proposal_node(proposal_builder),
    )
    builder.add_node(
        "compose_customer_answer",
        create_compose_customer_answer_node(answer_composer),
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
            "retrieve_customer_evidence": "retrieve_customer_evidence",
            "end": END,
        },
    )
    builder.add_edge("retrieve_customer_evidence", "build_refund_proposal")
    builder.add_edge("build_refund_proposal", "compose_customer_answer")
    builder.add_edge("compose_customer_answer", END)
    builder.add_edge("request_order_reference", END)

    return builder.compile()
