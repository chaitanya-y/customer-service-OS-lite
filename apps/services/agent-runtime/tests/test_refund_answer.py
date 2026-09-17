import json
from datetime import UTC, datetime

import pytest
from cso_observability import TelemetryState, initialize_telemetry
from opentelemetry.sdk._logs.export import (
    InMemoryLogRecordExporter,
    SimpleLogRecordProcessor,
)
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from pydantic import SecretStr

from agent_runtime import config as runtime_config
from agent_runtime.integrations.customer_evidence import CustomerEvidence
from agent_runtime.integrations.order_lookup import Money, OrderContext
from agent_runtime.refund.answer import (
    CustomerAnswer,
    DraftCustomerAnswer,
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
    build_fallback_customer_answer,
)
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.policy import VerifiedRefundPolicy
from agent_runtime.refund.presentation import format_requested_amount
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
        self.output_schema = None

    def with_structured_output(self, *args, **kwargs):
        self.output_schema = args[0]
        del kwargs
        return self.structured_model


class UsageResult(dict[str, object]):
    def __init__(self, values: dict[str, object], usage_metadata: dict[str, int]) -> None:
        super().__init__(values)
        self.usage_metadata = usage_metadata


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


def make_evidence(
    *,
    knowledge_document_id: str = "refund-policy-current-2026-08-01",
    chunk_id: str = "section-003-chunk-001",
    content: str = "Damaged items may be refunded.",
) -> CustomerEvidence:
    return CustomerEvidence.model_validate(
        {
            "knowledge_document_id": knowledge_document_id,
            "chunk_id": chunk_id,
            "content": content,
            "citation": {
                "source_uri": "s3://cso-knowledge/tenant-local/refund-policy-2026-08-01.md",
                "title": "Refund Policy",
                "section_path": ["Refund eligibility"],
            },
            "retrieval_methods": ["semantic_vector"],
            "reranker_rank": 1,
        }
    )


def make_verified_policy() -> VerifiedRefundPolicy:
    return VerifiedRefundPolicy(
        policy_version="refund-policy-v1",
        catalog_sha256="a" * 64,
        currency="USD",
        automatic_maximum_minor=10_000,
        approval_maximum_minor=50_000,
    )


@pytest.mark.asyncio
async def test_answer_composer_uses_internal_purpose_without_changing_public_shape(
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {
            "message": "This general guidance is replaced after validation.",
            "citations": [],
            "purpose": "amount_review",
        }
    )
    chat_model = FakeChatModel(structured_model)
    composer = LangChainRefundAnswerComposer(chat_model)  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="Does this amount need review?",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
        refund_policy=make_verified_policy(),
    )

    assert chat_model.output_schema is DraftCustomerAnswer
    assert set(answer.model_dump(by_alias=True)) == {"message", "citations"}
    assert answer.message.startswith("Your requested refund of $100")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "rejection_code"),
    [
        ("Order WRONG-1 needs review.", "CONFLICTING_IDENTIFIER"),
        ("Your $100 request needs review.", "MONEY_TEXT_REJECTED"),
        ("Your request is eligible.", "DELIVERY_AGE_TEXT_REJECTED"),
    ],
)
async def test_amount_review_still_rejects_unsafe_raw_model_output_before_rendering(
    order_context: OrderContext,
    message: str,
    rejection_code: str,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(
            FakeStructuredModel(
                {"message": message, "citations": [], "purpose": "amount_review"}
            )
        )  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Does this amount need review?",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
            refund_policy=make_verified_policy(),
        )

    assert captured.value.reason_code.value == rejection_code


@pytest.mark.asyncio
async def test_answer_composer_keeps_policy_and_trusted_money_out_of_model_input(
    order_context: OrderContext,
) -> None:
    model = FakeStructuredModel(
        {
            "message": "The amount needs review.",
            "citations": [],
            "purpose": "amount_review",
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    await composer.compose(
        customer_message="Does this amount need review?",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
        refund_policy=make_verified_policy(),
    )

    model_input = model.messages[1].content
    for forbidden in [
        "requestedAmount",
        "amountMinor",
        "refund-policy-v1",
        "catalogSha256",
        "10000",
        "50000",
    ]:
        assert forbidden not in model_input


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
async def test_answer_composer_tells_the_model_to_limit_delivery_window_explanations(
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

    system_prompt = structured_model.messages[0].content
    assert "general published policy" in system_prompt
    assert "within N calendar days of delivery" in system_prompt
    assert "same duration, time basis, and conditions" in system_prompt
    assert "Do not ask the customer for a delivery date" in system_prompt
    assert "Do not claim the customer's" in system_prompt
    assert "request is inside or outside a delivery window" in system_prompt


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
    assert answer.message == (f"{message}\n\nProposed refund: USD 100.00.")


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
async def test_answer_model_marks_a_guard_rejection_without_customer_content(
    order_context: OrderContext,
) -> None:
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    log_exporter = InMemoryLogRecordExporter()
    telemetry = initialize_telemetry(
        enabled=True,
        service_name="agent-runtime",
        service_version="test",
        environment_name="test",
        state=TelemetryState(),
        span_processor=SimpleSpanProcessor(span_exporter),
        metric_reader=metric_reader,
        log_processor=SimpleLogRecordProcessor(log_exporter),
    )
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(
            FakeStructuredModel(
                UsageResult(
                    {
                        "message": "Order WRONG-1 needs review.",
                        "citations": [],
                    },
                    {
                        "input_tokens": 19,
                        "output_tokens": 5,
                        "total_tokens": 24,
                    },
                )
            )
        ),  # type: ignore[arg-type]
        telemetry=telemetry,
    )

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="CANARY-CUSTOMER-MESSAGE",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence(content="CANARY-KNOWLEDGE-CONTENT")],
        )

    assert telemetry.force_flush() is True
    span = span_exporter.get_finished_spans()[0]
    assert span.attributes == {
        "operation": "model.refund_answer",
        "outcome": "guard_rejected",
        "model.cost.status": "unknown",
        "model.usage.input_tokens": 19,
        "model.usage.output_tokens": 5,
        "model.usage.total_tokens": 24,
    }
    exported = json.dumps(
        [span, metric_reader.get_metrics_data(), log_exporter.get_finished_logs()],
        default=lambda value: vars(value) if hasattr(value, "__dict__") else str(value),
    )
    assert "CANARY" not in exported


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
async def test_answer_composer_allows_order_reference_as_a_policy_noun_phrase(
    order_context: OrderContext,
) -> None:
    """The conjunction after `order reference` is prose, not an identifier."""
    message = "We verify the order reference and affected item before review."
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "Order ORDER-123: we will review your request.",
        "Order reference ORDER-123: we will review your request.",
    ],
)
async def test_answer_composer_allows_valid_order_reference_before_colon(
    order_context: OrderContext,
    message: str,
) -> None:
    """Removing terminal-delimiter handling would reject a trusted reference."""
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
async def test_answer_composer_rejects_wrong_order_reference_before_colon(
    order_context: OrderContext,
) -> None:
    """Stripping punctuation must not turn a conflicting reference into a match."""
    model = FakeStructuredModel(
        {"message": "Order reference WRONGREFERENCE: review pending.", "citations": []}
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="The item arrived damaged.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.reason_code.value == "CONFLICTING_IDENTIFIER"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reference", "message"),
    [
        ("ORDER-123:", "Order reference ORDER-123: review pending."),
        ("USD123", "Order reference USD123: review pending."),
    ],
)
async def test_answer_composer_preserves_exact_and_money_like_trusted_references(
    order_context: OrderContext,
    reference: str,
    message: str,
) -> None:
    """Changing exact-first matching or money masking would reject trusted text."""
    order_context = order_context.model_copy(update={"reference": reference})
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="The item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
async def test_answer_composer_exposes_safe_identifier_rejection_code_internally(
    order_context: OrderContext,
) -> None:
    model = FakeStructuredModel(
        {"message": "Your order reference is WRONGREFERENCE.", "citations": []}
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="The item arrived damaged.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert str(captured.value) == "Customer answer could not be composed"
    assert captured.value.reason_code.value == "CONFLICTING_IDENTIFIER"


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

    assert answer.message == (f"{message}\n\nProposed refund: USD 33.30.")


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
        "To continue, please provide: refund reason."
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
async def test_answer_composer_accepts_cited_general_delivery_policy_window(
    order_context: OrderContext,
) -> None:
    message = (
        "The published policy allows damaged-item refund requests within "
        "30 calendar days of delivery."
    )
    structured_model = FakeStructuredModel({"message": message, "citations": []})
    structured_model.result["citations"] = [
        {
            "knowledgeDocumentId": "refund-policy-current-2026-08-01",
            "chunkId": "section-003-chunk-001",
        }
    ]
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="Refund my damaged item.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                content=(
                    "Customers may request a refund for an item that arrived damaged "
                    "within 30 calendar days of delivery. Photo evidence is required "
                    "before approval."
                )
            )
        ],
    )

    assert answer.message == (
        f"{message}\n\n"
        "This is policy information, not confirmation that your request qualifies. "
        "Your delivery timing has not been verified.\n\n"
        "Proposed refund: USD 100.00."
    )


@pytest.mark.asyncio
async def test_answer_composer_adds_policy_frame_to_supported_delivery_window(
    order_context: OrderContext,
) -> None:
    """Removing app-owned framing would expose an unframed delivery-window claim."""
    message = (
        "Damaged-item refund requests are allowed within 30 calendar days of delivery."
    )
    model = FakeStructuredModel(
        {
            "message": message,
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
        customer_message="Refund my damaged item.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                content=(
                    "Damaged-item refund requests are allowed within 30 calendar "
                    "days of delivery."
                )
            )
        ],
    )

    assert answer.message.startswith(f"According to the published policy, {message}")
    assert "Your delivery timing has not been verified." in answer.message


@pytest.mark.asyncio
async def test_answer_composer_frames_the_same_normalized_text_it_validates(
    order_context: OrderContext,
) -> None:
    """Repairing raw text would let markdown-obscured unframed policy escape."""
    message = (
        "Damaged-item refunds are allowed within **３０** calendar days of delivery."
    )
    model = FakeStructuredModel(
        {
            "message": message,
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
        customer_message="Refund my damaged item.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                content="Damaged-item refunds are allowed within 30 calendar days of delivery."
            )
        ],
    )

    assert answer.message.startswith(
        "According to the published policy, Damaged-item refunds are allowed "
        "within **30** calendar days of delivery."
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("answer_scope", ["incorrect", "missing"])
async def test_answer_composer_accepts_one_explicit_incorrect_or_missing_alternative(
    order_context: OrderContext,
    answer_scope: str,
) -> None:
    """Removing explicit-OR support would reject a valid policy specialization."""
    message = (
        f"The published policy allows {answer_scope}-item refund requests within "
        "30 calendar days of delivery."
    )
    model = FakeStructuredModel(
        {
            "message": message,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-004-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message=f"My item is {answer_scope}.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                chunk_id="section-004-chunk-001",
                content=(
                    "Customers may request a refund within 30 calendar days of "
                    "delivery when Acme shipped an incorrect item or an item is "
                    "missing from the delivered order."
                ),
            )
        ],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
async def test_answer_composer_does_not_narrow_incorrect_and_missing_conjunction(
    order_context: OrderContext,
) -> None:
    """Replacing explicit-OR proof with subset matching would drop a prerequisite."""
    model = FakeStructuredModel(
        {
            "message": (
                "The published policy allows incorrect-item refund requests within "
                "30 calendar days of delivery."
            ),
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-004-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="My item is incorrect.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    chunk_id="section-004-chunk-001",
                    content=(
                        "Customers may request a refund within 30 calendar days of "
                        "delivery when an item is both incorrect and missing."
                    ),
                )
            ],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
async def test_answer_composer_does_not_treat_an_unrelated_or_as_policy_alternatives(
    order_context: OrderContext,
) -> None:
    """Matching any nearby OR would incorrectly authorize condition narrowing."""
    model = FakeStructuredModel(
        {
            "message": (
                "The published policy allows incorrect-item refund requests within "
                "30 calendar days of delivery."
            ),
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-004-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="My item is incorrect.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    chunk_id="section-004-chunk-001",
                    content=(
                        "Customers may request a refund within 30 calendar days of "
                        "delivery when an incorrect item needs photos or a missing "
                        "item needs an inventory check."
                    ),
                )
            ],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
async def test_answer_composer_rejects_captured_personalized_delivery_window_response(
    order_context: OrderContext,
) -> None:
    order_context = order_context.model_copy(
        update={
            "reference": "EVAL-REFUND-001",
            "items": [
                order_context.items[0].model_copy(update={"name": "Evaluation item"})
            ],
        }
    )
    raw_synthetic_answer = (
        "To request a damaged-item refund for order EVAL-REFUND-001, please "
        "provide the following:\n\n"
        "- Confirm the order and affected item: the item named 'Evaluation item' "
        "(quantity 1) as listed in your request.\n"
        "- Photo evidence showing the damage (required before a damaged-item refund "
        "can be considered).\n"
        "- Ensure your request is within 30 calendar days of delivery.\n\n"
        "Important notes on eligibility:\n"
        "- Final-sale items are not eligible for a refund under this policy, unless "
        "the item arrived damaged or Acme sent the wrong item.\n"
        "- Refunds cannot be considered for items outside the applicable window or "
        "for requests that cannot be matched to a verified order and customer.\n\n"
        "A support agent must verify the order and affected item before a refund is "
        "considered."
    )
    model = FakeStructuredModel(
        {
            "message": raw_synthetic_answer,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                },
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-006-chunk-001",
                },
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-004-chunk-001",
                },
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="My item arrived damaged.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    content=(
                        "Customers may request a refund for an item that arrived "
                        "damaged within 30 calendar days of delivery. The request must "
                        "identify the order and affected item. Photo evidence is "
                        "required before a damaged-item refund can be approved."
                    )
                ),
                make_evidence(
                    chunk_id="section-006-chunk-001",
                    content=(
                        "The following are not eligible for a refund under this "
                        "policy:\n\n- Final-sale products, unless the item arrived "
                        "damaged or Acme sent the wrong item. - Digital goods after "
                        "access or download has been provided. - Items outside the "
                        "applicable request window. - Requests that cannot be matched "
                        "to a verified order and customer."
                    ),
                ),
                make_evidence(
                    chunk_id="section-004-chunk-001",
                    content=(
                        "Customers may request a refund within 30 calendar days of "
                        "delivery when Acme shipped an incorrect item or an item is "
                        "missing from the delivered order. The support agent must "
                        "verify the order and affected item before a refund is "
                        "considered."
                    ),
                ),
            ],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("citations", "evidence"),
    [
        (
            [],
            [
                make_evidence(
                    content=(
                        "Damaged items may be refunded within 30 calendar days "
                        "of delivery."
                    )
                )
            ],
        ),
        (
            [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-004-chunk-001",
                }
            ],
            [
                make_evidence(
                    content=(
                        "Damaged items may be refunded within 30 calendar days "
                        "of delivery."
                    )
                ),
                make_evidence(
                    chunk_id="section-004-chunk-001",
                    content="Photo evidence is required for damaged items.",
                ),
            ],
        ),
    ],
)
async def test_answer_composer_rejects_delivery_window_without_supporting_citation(
    order_context: OrderContext,
    citations: list[dict[str, str]],
    evidence: list[CustomerEvidence],
) -> None:
    model = FakeStructuredModel(
        {
            "message": (
                "The published policy allows damaged-item refund requests within "
                "30 calendar days of delivery."
            ),
            "citations": citations,
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=evidence,
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("message", "evidence_content"),
    [
        (
            (
                "The published policy allows damaged-item refund requests within "
                "14 calendar days of delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows damaged-item refund requests within "
                "30 business days of delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows damaged-item refund requests within "
                "30 calendar days before delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows unopened-item refund requests within "
                "30 calendar days of delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows damaged-item refund requests within "
                "30 calendar days before delivery and within 30 calendar days "
                "of delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            "The published policy sets a 30-day request window for damaged-item refunds.",
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows damaged-item refunds 30 calendar days "
                "after delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
        (
            (
                "The published policy allows unopened, non-final-sale physical goods "
                "to be refunded within 14 calendar days of delivery."
            ),
            (
                "Unopened, non-final-sale physical goods may be refunded within 14 "
                "calendar days of delivery after the item is returned and inspected."
            ),
        ),
        (
            (
                "The published policy does not allow damaged-item refund requests "
                "within 30 calendar days of delivery."
            ),
            "Damaged items may be refunded within 30 calendar days of delivery.",
        ),
    ],
)
async def test_answer_composer_rejects_delivery_window_not_supported_by_cited_rule(
    order_context: OrderContext,
    message: str,
    evidence_content: str,
) -> None:
    model = FakeStructuredModel(
        {
            "message": message,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence(content=evidence_content)],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        (
            "The published policy allows damaged-item refund requests within "
            "30 calendar days of delivery. Your request qualifies under that window."
        ),
        (
            "The published policy allows damaged-item refund requests within "
            "30 calendar days of delivery. You qualify."
        ),
        "Your order is within 30 calendar days of delivery under the published policy.",
        "Your order is outside the 30-day delivery window.",
        "Your request qualifies under that delivery window.",
        "Please provide the delivery date so we can confirm your eligibility.",
        "What was your delivery date?",
        "When was your order delivered?",
    ],
)
async def test_answer_composer_rejects_personalized_delivery_conclusions_and_dates(
    order_context: OrderContext,
    message: str,
) -> None:
    model = FakeStructuredModel(
        {
            "message": message,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    content=(
                        "Damaged items may be refunded within 30 calendar days "
                        "of delivery."
                    )
                )
            ],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "The request does not meet standard refund eligibility.",
        (
            "Since your request concerns a final-sale product and no governed "
            "exception has yet been verified for the supplied item, it does not "
            "meet the standard refund eligibility."
        ),
    ],
)
async def test_answer_composer_rejects_singular_personalized_eligibility_denial(
    order_context: OrderContext,
    message: str,
) -> None:
    """Dropping the singular subject guard would allow an individual denial."""
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel({"message": message, "citations": []}))  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="What does the final-sale policy mean for me?",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
async def test_answer_composer_allows_general_plural_eligibility_policy(
    order_context: OrderContext,
) -> None:
    """Broadening the denial matcher to generic policy would create false positives."""
    message = "Requests that do not meet the published policy are not eligible."
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="What does the refund policy say?",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
async def test_answer_composer_allows_singular_procedural_eligibility_wording(
    order_context: OrderContext,
) -> None:
    """Matching any later eligibility word would reject supported procedure."""
    message = (
        "The request must identify the affected item before eligibility can be checked."
    )
    model = FakeStructuredModel(
        {
            "message": message,
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
        customer_message="What information does the request need?",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[make_evidence(content=message)],
    )

    assert answer.message.startswith(message)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        # Exact synthetic response from refund-ragas-v7-20260913-001.
        (
            "To request a damaged-item refund, please follow these prerequisites "
            "and steps:\n\n"
            "- Timeframe: The published policy allows damaged-item refund requests "
            "within 30 calendar days of delivery.\n"
            "- Identify the order and item: Your request must clearly identify "
            "the order and the affected item (include the order reference and "
            "the item name).\n"
            "- Photo evidence: Photo evidence is required before a damaged-item "
            "refund can be approved.\n"
            "- Verification: The support agent must verify the order and affected "
            "item before a refund is considered.\n\n"
            "Notes on eligibility:\n"
            "- Requests outside the applicable window are not eligible.\n"
            "- Items outside the window or that cannot be matched to a verified "
            "order/customer are not eligible.\n"
            "- Final-sale products are not eligible for a refund unless the item "
            "arrived damaged or the wrong item was sent; since your item arrived "
            "damaged, it falls under the damaged-item exception.\n\n"
            "If you’d like, you can share the photos of the damage and confirm "
            "the order reference (EVAL-REFUND-001) and the item name "
            "(Evaluation item) to proceed.\n"
        ),
        # Isolate the offending sentence: this is not a delivery-window failure.
        (
            "Final-sale products are not eligible for a refund unless the item "
            "arrived damaged or the wrong item was sent; since your item arrived "
            "damaged, it falls under the damaged-item exception."
        ),
    ],
    ids=["captured-v7-response", "isolated-exception-conclusion"],
)
async def test_answer_composer_rejects_captured_personalized_policy_exception(
    order_context: OrderContext,
    message: str,
) -> None:
    order_context = order_context.model_copy(
        update={
            "reference": "EVAL-REFUND-001",
            "items": [
                order_context.items[0].model_copy(update={"name": "Evaluation item"})
            ],
        }
    )
    model = FakeStructuredModel(
        {
            "message": message,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": chunk_id,
                }
                for chunk_id in [
                    "section-003-chunk-001",
                    "section-006-chunk-001",
                    "section-004-chunk-001",
                ]
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="My item arrived damaged. What do I need to request a refund?",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    content=(
                        "Customers may request a refund for an item that arrived "
                        "damaged within 30 calendar days of delivery. Photo evidence "
                        "is required before approval."
                    )
                ),
                make_evidence(
                    chunk_id="section-006-chunk-001",
                    content=(
                        "The following are not eligible for a refund under this "
                        "policy: Final-sale products, unless the item arrived "
                        "damaged or Acme sent the wrong item."
                    ),
                ),
                make_evidence(
                    chunk_id="section-004-chunk-001",
                    content=(
                        "For incorrect or missing items, support must verify the "
                        "order and affected item before a refund is considered."
                    ),
                ),
            ],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"
    assert captured.value.rejected_answer is None


@pytest.mark.asyncio
async def test_answer_composer_accepts_general_policy_exception_without_deciding_eligibility(
    order_context: OrderContext,
) -> None:
    message = (
        "The published policy allows damaged-item refund requests within "
        "30 calendar days of delivery. Photo evidence is required before a "
        "damaged-item refund can be approved. The policy's final-sale exclusion "
        "has exceptions for items that arrived damaged or were incorrectly supplied."
    )
    model = FakeStructuredModel(
        {
            "message": message,
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                },
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-006-chunk-001",
                },
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="My final-sale item arrived damaged. What does the policy say?",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                content=(
                    "Customers may request a refund for an item that arrived damaged "
                    "within 30 calendar days of delivery. Photo evidence is required "
                    "before approval."
                )
            ),
            make_evidence(
                chunk_id="section-006-chunk-001",
                content=(
                    "The following are not eligible for a refund under this policy: "
                    "Final-sale products, unless the item arrived damaged or Acme "
                    "sent the wrong item."
                ),
            ),
        ],
    )

    assert answer.message == (
        f"{message}\n\n"
        "This is policy information, not confirmation that your request qualifies. "
        "Your delivery timing has not been verified.\n\n"
        "Proposed refund: USD 100.00."
    )
    assert [citation.chunk_id for citation in answer.citations] == [
        "section-003-chunk-001",
        "section-006-chunk-001",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "Your request has not been assessed for eligibility.",
        "Your request's eligibility has not been verified.",
        "Your request's eligibility has not been determined.",
        "Ｙｏｕｒ ｒｅｑｕｅｓｔ ｈａｓ ｎｏｔ ｂｅｅｎ ａｓｓｅｓｓｅｄ ｆｏｒ ｅｌｉｇｉｂｉｌｉｔｙ．",
    ],
)
async def test_answer_composer_normalizes_bounded_eligibility_uncertainty(
    order_context: OrderContext,
    message: str,
) -> None:
    model_answer = CustomerAnswer(message=message, citations=[])
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel(model_answer))  # type: ignore[arg-type]
    )
    proposal = make_proposal(order_context)
    proposal = proposal.model_copy(
        update={"intent": proposal.intent.model_copy(update={"requested_amount": None})}
    )

    answer = await composer.compose(
        customer_message="Refund my damaged item.",
        refund_proposal=proposal,
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message == (
        "This is policy information, not confirmation that your request qualifies. "
        "Your delivery timing has not been verified."
    )
    assert answer.citations == []


@pytest.mark.asyncio
async def test_answer_composer_appends_app_qualification_once_with_policy_window(
    order_context: OrderContext,
) -> None:
    policy_statement = (
        "The published policy allows damaged-item refund requests within "
        "30 calendar days of delivery."
    )
    model = FakeStructuredModel(
        {
            "message": (
                f"{policy_statement} "
                "Your request has not been assessed for eligibility."
            ),
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
        customer_message="Refund my damaged item.",
        refund_proposal=make_proposal(order_context),
        order_context=order_context,
        knowledge_evidence=[
            make_evidence(
                content=(
                    "Damaged items may be refunded within 30 calendar days of delivery."
                )
            )
        ],
    )

    qualification = (
        "This is policy information, not confirmation that your request qualifies. "
        "Your delivery timing has not been verified."
    )
    assert answer.message.count(qualification) == 1
    assert "has not been assessed for eligibility" not in answer.message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "message",
    [
        "Your request is eligible.",
        "Your request is not eligible.",
        "Please provide your delivery date.",
        "Your request has not been assessed for eligibility, but it is eligible.",
        "Your request has not been assessed for eligibility; it is eligible.",
        "Notice: Your request has not been assessed for eligibility.",
        (
            "Your request has not been assessed for eligibility\n"
            "because your request is eligible."
        ),
        ("Your request has not been assessed for eligibility. It is eligible."),
        (
            "Your request has not been assessed for eligibility. "
            "Your request is not eligible."
        ),
        (
            "Your request has not been assessed for eligibility. "
            "Please provide your delivery date."
        ),
    ],
)
async def test_answer_composer_does_not_let_safe_uncertainty_mask_unsafe_text(
    order_context: OrderContext,
    message: str,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel({"message": message, "citations": []}))  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.reason_code.value == "DELIVERY_AGE_TEXT_REJECTED"


@pytest.mark.asyncio
async def test_answer_composer_captures_original_rejected_answer_only_when_enabled(
    order_context: OrderContext,
) -> None:
    message = "Your request is eligible."
    model_answer = CustomerAnswer(message=message, citations=[])
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel(model_answer)),  # type: ignore[arg-type]
        capture_rejected_answer=True,
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    rejected_answer = captured.value.rejected_answer
    assert rejected_answer == CustomerAnswer(message=message, citations=[])
    assert rejected_answer is not model_answer
    model_answer.message = "Provider object mutated after rejection."
    assert rejected_answer.message == message
    assert "Proposed refund:" not in rejected_answer.message


@pytest.mark.asyncio
async def test_answer_composer_does_not_capture_rejected_answer_by_default(
    order_context: OrderContext,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(
            FakeStructuredModel(
                {"message": "Your request is eligible.", "citations": []}
            )
        )  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.rejected_answer is None


@pytest.mark.asyncio
async def test_answer_composer_never_captures_invalid_raw_model_output(
    order_context: OrderContext,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel("invalid model output")),  # type: ignore[arg-type]
        capture_rejected_answer=True,
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.reason_code.value == "MODEL_OUTPUT_INVALID"
    assert captured.value.rejected_answer is None


@pytest.mark.asyncio
async def test_answer_composer_captures_model_answer_before_trusted_amount_append(
    order_context: OrderContext,
) -> None:
    message = "a" * 1990
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(FakeStructuredModel({"message": message, "citations": []})),  # type: ignore[arg-type]
        capture_rejected_answer=True,
    )

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[make_evidence()],
        )

    assert captured.value.reason_code.value == "FINAL_ANSWER_CONTRACT_INVALID"
    assert captured.value.rejected_answer == CustomerAnswer(
        message=message,
        citations=[],
    )


@pytest.mark.asyncio
async def test_answer_composer_leaves_ordinary_no_window_answer_unchanged(
    order_context: OrderContext,
) -> None:
    message = "The published policy allows damaged-item refund requests."
    model = FakeStructuredModel({"message": message, "citations": []})
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    proposal = make_proposal(order_context)
    proposal = proposal.model_copy(
        update={"intent": proposal.intent.model_copy(update={"requested_amount": None})}
    )
    answer = await composer.compose(
        customer_message="Refund my damaged item.",
        refund_proposal=proposal,
        order_context=order_context,
        knowledge_evidence=[make_evidence()],
    )

    assert answer.message == message


@pytest.mark.asyncio
async def test_composer_enforces_length_after_delivery_qualification_and_amount(
    order_context: OrderContext,
) -> None:
    policy_statement = (
        "The published policy allows damaged-item refund requests within "
        "30 calendar days of delivery."
    )
    model = FakeStructuredModel(
        {
            "message": f"{policy_statement} {'a' * 1875}",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(model))  # type: ignore[arg-type]

    with pytest.raises(RefundAnswerCompositionError) as captured:
        await composer.compose(
            customer_message="Refund my damaged item.",
            refund_proposal=make_proposal(order_context),
            order_context=order_context,
            knowledge_evidence=[
                make_evidence(
                    content=(
                        "Damaged items may be refunded within 30 calendar days "
                        "of delivery."
                    )
                )
            ],
        )

    assert captured.value.reason_code.value == "FINAL_ANSWER_CONTRACT_INVALID"


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
    assert "Proposed refund: USD 100.00." in answer.message


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
        "Please provide photos of the damage.\n\nProposed refund: USD 1,678.80."
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
    assert "Proposed refund:" not in fallback.message


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
    assert "Proposed refund:" not in fallback.message


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
