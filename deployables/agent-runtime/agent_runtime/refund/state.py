from typing import Literal, TypedDict

from agent_runtime.integrations.order_lookup import OrderContext


class RefundState(TypedDict, total=False):
    customer_message: str
    order_reference: str | None
    order_context: OrderContext | None
    error_code: str | None
    journey: Literal["refund"]
    status: Literal[
        "request_received",
        "awaiting_order_reference",
        "order_reference_received",
        "order_context_loaded",
        "order_not_found",
        "order_lookup_unavailable",
    ]
