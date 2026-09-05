from pydantic import BaseModel, ConfigDict, Field


class ConversationCustomerMessage(BaseModel):
    """Bounded, untrusted customer-only context from Conversation Runtime."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    sequence_number: int = Field(gt=0)
    text: str = Field(min_length=1, max_length=2_000)
