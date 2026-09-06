import json
from datetime import UTC, datetime

import pytest
from pydantic import SecretStr

from agent_runtime import config as runtime_config
from agent_runtime.integrations.customer_evidence import CustomerEvidence
from agent_runtime.integrations.order_lookup import Money, OrderContext
from agent_runtime.refund.answer import (
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
    build_fallback_customer_answer,
    format_requested_amount,
)
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import (
    RefundProposalBuilder,
    RefundProposalVersions,
)


class FakeStructuredModel:
    def __init__(self, result: object) -> None:
        self.result = result
        self.messages = []

    async def ainvoke(self, messages):
        self.messages = messages
        return self.result


class FakeChatModel:
    def __init__(self, structured_model: FakeStructuredModel) -> None:
        self.structured_model = structured_model

    def with_structured_output(self, *args, **kwargs):
        del args, kwargs
        return self.structured_model


def make_proposal(
    order_context: OrderContext,
    extraction: RefundIntentExtraction | None = None,
):
    identifiers = iter(["proposal-1", "execution-1"])
    builder = RefundProposalBuilder(
        versions=RefundProposalVersions(
            agent_release_id="agent-runtime-test",
            prompt_bundle_version="refund-intent-v1",
            model_route_id="refund-intent-test-model",
            knowledge_release_id="refund-policy-2026-08-01",
            guardrail_version="refund-proposal-guardrails-v1",
            evaluation_version="evaluation-test-v1",
            order_lookup_tool_version="lookup-order-v1",
        ),
        create_id=lambda: next(identifiers),
        now=lambda: datetime(2026, 8, 14, 12, 0, tzinfo=UTC),
    )
    return builder.build(
        extraction=extraction
        or RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        ),
        order_context=order_context,
        turn_id="turn-1",
        trace_id="trace-1",
    )


def make_evidence() -> CustomerEvidence:
    return CustomerEvidence.model_validate(
        {
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
            "content": "Damaged items may be refunded.",
            "citation": {
                "source_uri": "s3://cso-knowledge/tenant-local/refund-policy-2026-08-01.md",
                "title": "Refund Policy",
                "section_path": ["Refund eligibility"],
            },
            "retrieval_methods": ["semantic_vector"],
            "reranker_rank": 1,
        }
    )


@pytest.mark.asyncio
async def test_answer_composer_accepts_a_citation_from_retrieved_evidence(
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {
            "message": "Damaged items may be eligible for a refund review.",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="My item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.citations[0].chunk_id == "section-003-chunk-001"
    assert len(structured_model.messages) == 2


@pytest.mark.asyncio
async def test_answer_composer_tells_the_model_not_to_invent_delivery_age_rules(
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {"message": "We will review your refund request.", "citations": []}
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    await composer.compose(
        customer_message="My item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert (
        "Do not ask the customer for a delivery date or state a delivery-age window."
        in structured_model.messages[0].content
    )


@pytest.mark.asyncio
async def test_answer_composer_sends_display_facts_without_execution_identifiers(
    order_context: OrderContext,
) -> None:
    selected_item = order_context.items[0].model_copy(update={"item_id": "3"})
    other_item = selected_item.model_copy(update={"item_id": "4", "name": "Red Shirt"})
    order_context = order_context.model_copy(
        update={
            "reference": "AVV8JSZH8G6ZZDMX",
            "items": [selected_item, other_item],
        }
    )
    proposal = make_proposal(
        order_context,
        RefundIntentExtraction(
            reason_code="DAMAGED", scope="SELECTED_ITEMS", selected_item_ids=["3"]
        ),
    )
    original_proposal = proposal.model_dump()
    message = "We will review the Blue Shirt in order AVV8JSZH8G6ZZDMX."
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The item arrived damaged. Refund item 3.",
        refund_proposal=proposal,
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    model_input = json.loads(structured_model.messages[1].content)
    assert set(model_input) == {"customerMessage", "refundRequest", "knowledgeEvidence"}
    assert model_input["refundRequest"] == {
        "orderReference": "AVV8JSZH8G6ZZDMX",
        "reasonCode": "DAMAGED",
        "scope": "SELECTED_ITEMS",
        "items": [{"name": "Blue Shirt", "quantity": 1}],
        "missingDetails": [],
    }
    assert model_input["customerMessage"] == "The item arrived damaged. Refund item 3."
    assert proposal.model_dump() == original_proposal
    assert proposal.intent.order_id == "3"
    assert proposal.intent.item_ids == ["3"]
    assert answer.message == (
        f"{message}\n\nProposed refund amount: USD 100.00. "
        "This is a request, not a refund approval."
    )


@pytest.mark.asyncio
async def test_answer_composer_rejects_a_citation_not_in_retrieved_evidence(
    order_context: OrderContext,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(
            FakeStructuredModel(
                {
                    "message": "This is unsupported.",
                    "citations": [
                        {
                            "knowledgeDocumentId": "internal-playbook",
                            "chunkId": "section-001-chunk-001",
                        }
                    ],
                }
            )
        )  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="My item arrived damaged.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "We will review item 3 in order 3.",
        "We will review order #3.",
        'We will review Order ID: "3".',
        "We will review **order 3**.",
        "We will review order OTHER-987.",
        "We will review item 3 in order ORDER-123.",
        "The order reference is 3.",
        "The order number is 3.",
        "The item ID is 3.",
        "Your order reference: WRONGREFERENCE.",
    ],
)
async def test_answer_composer_rejects_internal_order_id_in_customer_text(
    order_context: OrderContext,
    message: str,
) -> None:
    order_context = order_context.model_copy(
        update={"items": [order_context.items[0].model_copy(update={"item_id": "3"})]}
    )
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(structured_model)  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="The item arrived damaged. Refund item 3.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "You requested a review of 3 Blue Shirts in order ORDER-123.",
        "You received your order 3 days ago. We will review order ORDER-123.",
        "You received your order 3 business days ago.",
    ],
)
async def test_answer_composer_keeps_legitimate_quantities_and_amounts(
    order_context: OrderContext,
    message: str,
) -> None:
    item = order_context.items[0]
    order_context = order_context.model_copy(
        update={
            "total": order_context.total.model_copy(update={"amount_minor": 3330}),
            "items": [
                item.model_copy(
                    update={
                        "quantity": 3,
                        "unit_price": item.unit_price.model_copy(
                            update={"amount_minor": 1110}
                        ),
                        "line_total": item.line_total.model_copy(
                            update={"amount_minor": 3330}
                        ),
                    }
                )
            ],
        }
    )
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="Review 3 shirts for USD 33.30.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message == (
        f"{message}\n\nProposed refund amount: USD 33.30. "
        "This is a request, not a refund approval."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "intent_update",
    [
        {"order_id": "different-order"},
        {"scope": "SELECTED_ITEMS", "item_ids": ["unknown-item"]},
    ],
)
async def test_answer_composer_rejects_mismatched_facts_before_model_call(
    order_context: OrderContext,
    intent_update: dict[str, object],
) -> None:
    proposal = make_proposal(order_context)
    proposal = proposal.model_copy(
        update={"intent": proposal.intent.model_copy(update=intent_update)}
    )
    structured_model = FakeStructuredModel({"message": "Unused", "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="Refund my order.",
            refund_proposal=proposal,
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert structured_model.messages == []


def test_fallback_answer_does_not_claim_a_refund_decision(
    order_context: OrderContext,
) -> None:
    fallback = build_fallback_customer_answer(
        make_proposal(order_context), order_context=order_context
    )

    assert fallback.citations == []
    assert "order ORDER-123" in fallback.message
    assert "approved" not in fallback.message.lower()
    assert "denied" not in fallback.message.lower()


def test_fallback_preserves_missing_details_and_public_order_reference(
    order_context: OrderContext,
) -> None:
    proposal = make_proposal(order_context).model_copy(
        update={"missing_fields": ["REFUND_REASON"]}
    )

    fallback = build_fallback_customer_answer(proposal, order_context=order_context)

    assert fallback.message == (
        "I have captured your refund request for order ORDER-123. "
        "To continue, please provide: refund reason.\n\n"
        "Proposed refund amount: USD 100.00. "
        "This is a request, not a refund approval."
    )
    assert fallback.citations == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "The proposed refund amount is 167,880 USD.",
        "The requested refund is USD167880.",
        "The proposed refund is $167,880.00.",
        "The requested refund is 167880 dollars.",
        "The refund is one hundred and sixty-seven thousand dollars.",
        "The proposed amount is 167880.",
        "The requested refund is 167880.",
        "I have proposed a refund of 167,880.",
        "I recorded 167880 as the refund total.",
        "The refund is 167\u00a0880 USD.",
        "The refund is ＄１６７，８８０．００.",
        "The proposed refund is EUR 1,678.80.",
        "The proposed refund is NZD167880.",
        "The proposed refund is USD 1,678.80.",
        "Refunds above $2,000 need review.",
    ],
)
async def test_answer_composer_rejects_cents_presented_as_dollars(
    order_context: OrderContext,
    message: str,
) -> None:
    order_context = order_context.model_copy(
        update={
            "total": order_context.total.model_copy(update={"amount_minor": 167880})
        }
    )
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence().model_copy(
                    update={"content": "Refunds above USD 2,000 require review."}
                )
            ],
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "Please provide the delivery date so we can confirm your eligibility.",
        "Refund requests must be submitted within 30 calendar days of delivery.",
    ],
)
async def test_answer_composer_rejects_unenforced_delivery_date_requirements(
    order_context: OrderContext,
    message: str,
) -> None:
    """A delivery-age gate is not implemented or collectable in this journey."""
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )


@pytest.mark.parametrize(
    ("amount_minor", "display"),
    [
        (0, "USD 0.00"),
        (1, "USD 0.01"),
        (101, "USD 1.01"),
        (167880, "USD 1,678.80"),
        (9_007_199_254_740_991, "USD 90,071,992,547,409.91"),
    ],
)
def test_format_requested_amount_uses_exact_integer_arithmetic(
    amount_minor: int,
    display: str,
) -> None:
    assert (
        format_requested_amount(Money(amount_minor=amount_minor, currency="USD"))
        == display
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reference", "product"),
    [("ABC123", "RTX4090"), ("USD123", "3 RAM modules")],
)
async def test_product_and_order_codes_are_not_mistaken_for_currency(
    order_context: OrderContext,
    reference: str,
    product: str,
) -> None:
    order_context = order_context.model_copy(
        update={
            "reference": reference,
            "items": [order_context.items[0].model_copy(update={"name": product})],
        }
    )
    message = f"Please provide photos of your {product} from order {reference}."
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The product arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message.startswith(message)
    assert "Proposed refund amount: USD 100.00." in answer.message


@pytest.mark.asyncio
async def test_composer_appends_trusted_money_without_sending_it_to_model(
    order_context: OrderContext,
) -> None:
    order_context = order_context.model_copy(
        update={
            "total": order_context.total.model_copy(update={"amount_minor": 167880})
        }
    )
    proposal = make_proposal(order_context)
    original_proposal = proposal.model_dump()
    model = FakeStructuredModel(
        {
            "message": "Please provide photos of the damage.",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The item arrived damaged.",
        refund_proposal=proposal,
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert "requestedAmount" not in model.messages[1].content
    assert "amountMinor" not in model.messages[1].content
    assert "167880" not in model.messages[1].content
    assert "1,678.80" not in model.messages[1].content
    assert answer.message == (
        "Please provide photos of the damage.\n\n"
        "Proposed refund amount: USD 1,678.80. "
        "This is a request, not a refund approval."
    )
    assert answer.citations[0].chunk_id == "section-003-chunk-001"
    assert proposal.model_dump() == original_proposal


@pytest.mark.asyncio
@pytest.mark.parametrize("currency", [None, "JPY", "KWD", "EUR"])
async def test_absent_or_unsupported_money_is_not_invented(
    order_context: OrderContext,
    currency: str | None,
) -> None:
    proposal = make_proposal(order_context)
    amount = Money(amount_minor=167880, currency=currency) if currency else None
    proposal = proposal.model_copy(
        update={
            "intent": proposal.intent.model_copy(update={"requested_amount": amount})
        }
    )
    model = FakeStructuredModel({"message": "Please provide photos.", "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="Refund my item.",
        refund_proposal=proposal,
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert format_requested_amount(amount) is None
    assert answer.message == "Please provide photos."
    fallback = build_fallback_customer_answer(proposal, order_context=order_context)
    assert "Proposed refund amount" not in fallback.message


@pytest.mark.asyncio
async def test_composer_enforces_length_limit_after_appending_amount(
    order_context: OrderContext,
) -> None:
    model = FakeStructuredModel({"message": "a" * 1990, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="Refund my item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )


def test_fallback_does_not_show_amount_from_another_order(
    order_context: OrderContext,
) -> None:
    proposal = make_proposal(order_context)
    proposal = proposal.model_copy(
        update={
            "intent": proposal.intent.model_copy(update={"order_id": "another-order"})
        }
    )

    fallback = build_fallback_customer_answer(proposal, order_context=order_context)

    assert "order ORDER-123" in fallback.message
    assert "Proposed refund amount" not in fallback.message


@pytest.mark.asyncio
async def test_configured_answer_composer_uses_a_single_bounded_attempt(
    monkeypatch: pytest.MonkeyPatch,
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {
            "message": "Please share photos of the damaged item.",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    captured_options: dict[str, object] = {}

    class FakeSettings:
        refund_answer_model = "test-answer-model"
        openai_api_key = SecretStr("test-api-key")
        refund_answer_model_timeout_seconds = 30.0

    class FakeConfiguredChatModel:
        def __init__(self, **kwargs: object) -> None:
            captured_options.update(kwargs)

        def with_structured_output(self, *args: object, **kwargs: object):
            del args, kwargs
            return structured_model

    monkeypatch.setattr(runtime_config, "RefundAnswerModelSettings", FakeSettings)
    monkeypatch.setattr(runtime_config, "ChatOpenAI", FakeConfiguredChatModel)

    composer = runtime_config.ConfiguredRefundAnswerComposer()
    answer = await composer.compose(
        customer_message="My item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.citations[0].chunk_id == "section-003-chunk-001"
    assert captured_options["model"] == "test-answer-model"
    assert captured_options["max_retries"] == 0
    assert captured_options["timeout"] == 30.0
