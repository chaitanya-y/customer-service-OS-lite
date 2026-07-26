from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RefundIntakeRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    customer_message: str = Field(min_length=1, max_length=2000)
    order_reference: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
    )


class RefundIntakeResponse(BaseModel):
    customer_message: str
    order_reference: str | None
    journey: Literal["refund"]
    status: Literal[
        "awaiting_order_reference",
        "order_reference_received",
    ]