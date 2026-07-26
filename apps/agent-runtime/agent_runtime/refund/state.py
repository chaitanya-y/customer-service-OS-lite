from typing import Literal, TypedDict


class RefundState(TypedDict, total=False):
    customer_message: str
    order_reference: str | None
    journey: Literal["refund"]
    status: Literal[
        "request_received",
        "awaiting_order_reference",
        "order_reference_received",
    ]