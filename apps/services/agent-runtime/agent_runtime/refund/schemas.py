from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_runtime.integrations.order_lookup import OrderContext
from agent_runtime.refund.answer import CustomerAnswer
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.refund.proposal import RefundProposal


class RefundIntakeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    customer_message: str = Field(min_length=1, max_length=2000)
    order_reference: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
    )
    conversation_messages: list[ConversationCustomerMessage] = Field(
        default_factory=list,
        max_length=8,
    )

    @model_validator(mode="after")
    def validate_conversation_messages(self) -> RefundIntakeRequest:
        if not self.conversation_messages:
            return self

        sequence_numbers = [
            message.sequence_number for message in self.conversation_messages
        ]
        if sequence_numbers != sorted(sequence_numbers):
            raise ValueError("conversation_messages must be ordered by sequence_number")
        if len(sequence_numbers) != len(set(sequence_numbers)):
            raise ValueError(
                "conversation_messages must have unique sequence_number values"
            )
        if self.conversation_messages[-1].text != self.customer_message:
            raise ValueError(
                "the final conversation message must match customer_message"
            )
        if sum(len(message.text) for message in self.conversation_messages) > 8_000:
            raise ValueError("conversation_messages exceed the 8000 character limit")

        return self


class RefundIntakeResponse(BaseModel):
    customer_message: str
    order_reference: str | None
    order_context: OrderContext | None = None
    refund_proposal: RefundProposal | None = None
    customer_answer: CustomerAnswer | None = None
    error_code: str | None = None
    journey: Literal["refund"]
    status: Literal[
        "awaiting_order_reference",
        "order_context_loaded",
        "awaiting_refund_details",
        "refund_proposal_ready",
        "intent_extraction_unavailable",
        "order_not_found",
        "order_lookup_unavailable",
    ]
