from typing import Literal, TypedDict

from agent_runtime.integrations.customer_evidence import CustomerEvidence
from agent_runtime.integrations.order_lookup import OrderContext
from agent_runtime.refund.answer import CustomerAnswer
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import RefundProposal


class RefundState(TypedDict, total=False):
    customer_message: str
    order_reference: str | None
    order_context: OrderContext | None
    refund_intent: RefundIntentExtraction | None
    refund_proposal: RefundProposal | None
    knowledge_evidence: list[CustomerEvidence]
    knowledge_retrieval_status: Literal["retrieved", "unavailable"]
    customer_answer: CustomerAnswer
    answer_composition_status: Literal["generated", "fallback"]
    tenant_id: str
    environment_id: str
    context_id: str
    request_id: str
    turn_id: str
    trace_id: str
    error_code: str | None
    journey: Literal["refund"]
    status: Literal[
        "request_received",
        "awaiting_order_reference",
        "order_reference_received",
        "order_context_loaded",
        "refund_intent_extracted",
        "awaiting_refund_details",
        "refund_proposal_ready",
        "intent_extraction_unavailable",
        "order_not_found",
        "order_lookup_unavailable",
    ]
