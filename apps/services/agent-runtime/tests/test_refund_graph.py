from datetime import UTC, datetime

import pytest

from agent_runtime.integrations.customer_evidence import (
    CustomerEvidence,
    CustomerEvidenceLookupUnauthorizedError,
    CustomerEvidenceLookupUnavailableError,
    CustomerEvidenceResponse,
)
from agent_runtime.integrations.order_lookup import (
    OrderContext,
    OrderLookupUnauthorizedError,
    OrderLookupUnavailableError,
    OrderNotFoundError,
)
from agent_runtime.refund.answer import (
    CustomerAnswer,
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
)
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.refund.graph import (
    MISSING_ORDER_REFERENCE_MESSAGE,
    build_refund_graph,
    create_compose_customer_answer_node,
)
from agent_runtime.refund.intent import (
    RefundIntentExtraction,
    RefundIntentExtractionError,
)
from agent_runtime.refund.proposal import (
    RefundProposalBuilder,
    RefundProposalVersions,
)


class FakeOrderLookup:
    def __init__(
        self,
        *,
        result: OrderContext | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result
        self.error = error
        self.references: list[str] = []

    async def lookup_order(self, order_reference: str) -> OrderContext:
        self.references.append(order_reference)

        if self.error:
            raise self.error

        if self.result is None:
            raise AssertionError("A fake result or error is required")

        return self.result


class FakeRefundIntentExtractor:
    def __init__(
        self,
        *,
        result: RefundIntentExtraction | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result or RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        )
        self.error = error
        self.messages: list[str] = []
        self.conversation_messages: list[list[ConversationCustomerMessage]] = []

    async def extract(
        self,
        *,
        customer_message: str,
        conversation_messages: list[ConversationCustomerMessage],
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        self.messages.append(customer_message)
        self.conversation_messages.append(conversation_messages)

        if self.error:
            raise self.error

        return self.result


class FakeCustomerEvidenceLookup:
    def __init__(
        self,
        *,
        result: CustomerEvidenceResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result or CustomerEvidenceResponse(
            knowledge_release_id="refund-policy-2026-08-01",
            evidence=[],
        )
        self.error = error
        self.queries: list[str] = []

    async def retrieve_customer_evidence(
        self,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        self.queries.append(query_text)

        if self.error:
            raise self.error

        return self.result


class FakeRefundAnswerComposer:
    def __init__(
        self,
        *,
        result: CustomerAnswer | None = None,
        error: Exception | None = None,
    ) -> None:
        self.result = result or CustomerAnswer(
            message="I have captured your refund request.",
            citations=[],
        )
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def compose(self, **kwargs) -> CustomerAnswer:
        self.calls.append(kwargs)

        if self.error:
            raise self.error

        return self.result


def create_proposal_builder() -> RefundProposalBuilder:
    identifiers = iter(["proposal-1", "execution-1"])
    return RefundProposalBuilder(
        versions=RefundProposalVersions(
            agent_release_id="agent-runtime-test",
            prompt_bundle_version="refund-intent-v1",
            model_route_id="refund-intent-test-model",
            knowledge_release_id="knowledge-not-used",
            guardrail_version="refund-proposal-guardrails-v1",
            evaluation_version="refund-proposal-eval-v1",
            order_lookup_tool_version="lookup-order-v1",
        ),
        create_id=lambda: next(identifiers),
        now=lambda: datetime(2026, 8, 2, 12, 0, tzinfo=UTC),
    )


def create_graph(
    order_lookup: FakeOrderLookup,
    intent_extractor: FakeRefundIntentExtractor | None = None,
    customer_evidence_lookup: FakeCustomerEvidenceLookup | None = None,
    answer_composer: FakeRefundAnswerComposer | None = None,
):
    extractor = intent_extractor or FakeRefundIntentExtractor()
    evidence_lookup = customer_evidence_lookup or FakeCustomerEvidenceLookup()
    composer = answer_composer or FakeRefundAnswerComposer()
    return (
        build_refund_graph(
            order_lookup,
            extractor,
            create_proposal_builder(),
            evidence_lookup,
            composer,
        ),
        extractor,
    )


@pytest.mark.asyncio
async def test_refund_graph_builds_a_ready_proposal(
    order_context: OrderContext,
) -> None:
    order_lookup = FakeOrderLookup(result=order_context)
    graph, intent_extractor = create_graph(order_lookup)

    result = await graph.ainvoke(
        {
            "customer_message": "  I want a refund.  ",
            "order_reference": "  ORDER-123  ",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["customer_message"] == "I want a refund."
    assert result["order_context"] == order_context
    assert result["status"] == "refund_proposal_ready"
    assert result["refund_proposal"].intent.order_id == "3"
    assert result["refund_proposal"].missing_fields == []
    assert order_lookup.references == ["ORDER-123"]
    assert intent_extractor.messages == ["I want a refund."]
    assert intent_extractor.conversation_messages == [[]]
    assert result["knowledge_evidence"] == []
    assert result["knowledge_retrieval_status"] == "retrieved"
    assert result["answer_composition_status"] == "fallback"
    assert "order ORDER-123" in result["customer_answer"].message


@pytest.mark.asyncio
async def test_refund_graph_requests_missing_order_reference() -> None:
    order_lookup = FakeOrderLookup()
    graph, intent_extractor = create_graph(order_lookup)

    result = await graph.ainvoke({"customer_message": "I want a refund."})

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": None,
        "customer_answer": CustomerAnswer(
            message=MISSING_ORDER_REFERENCE_MESSAGE,
            citations=[],
        ),
        "journey": "refund",
        "status": "awaiting_order_reference",
    }
    assert order_lookup.references == []
    assert intent_extractor.messages == []


@pytest.mark.asyncio
async def test_refund_graph_forwards_bounded_customer_history_to_intent_extraction(
    order_context: OrderContext,
) -> None:
    order_lookup = FakeOrderLookup(result=order_context)
    graph, intent_extractor = create_graph(order_lookup)
    conversation_messages = [
        ConversationCustomerMessage(
            sequence_number=1,
            text="My order reference is ORDER-123.",
        ),
        ConversationCustomerMessage(
            sequence_number=3,
            text="The item arrived damaged and I want a full refund.",
        ),
    ]

    await graph.ainvoke(
        {
            "customer_message": "The item arrived damaged and I want a full refund.",
            "conversation_messages": conversation_messages,
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert intent_extractor.conversation_messages == [conversation_messages]


@pytest.mark.asyncio
async def test_refund_graph_records_order_not_found() -> None:
    graph, _ = create_graph(FakeOrderLookup(error=OrderNotFoundError()))

    result = await graph.ainvoke(
        {
            "customer_message": "I want a refund.",
            "order_reference": "MISSING",
        }
    )

    assert result["status"] == "order_not_found"
    assert result["error_code"] == "order_not_found"
    assert result["order_context"] is None


@pytest.mark.asyncio
async def test_refund_graph_records_order_lookup_unavailable() -> None:
    graph, _ = create_graph(FakeOrderLookup(error=OrderLookupUnavailableError()))

    result = await graph.ainvoke(
        {
            "customer_message": "I want a refund.",
            "order_reference": "ORDER-123",
        }
    )

    assert result["status"] == "order_lookup_unavailable"
    assert result["error_code"] == "order_lookup_unavailable"
    assert result["order_context"] is None


@pytest.mark.asyncio
async def test_refund_graph_does_not_convert_authorization_into_agent_state() -> None:
    graph, _ = create_graph(FakeOrderLookup(error=OrderLookupUnauthorizedError()))

    with pytest.raises(OrderLookupUnauthorizedError):
        await graph.ainvoke(
            {
                "customer_message": "I want a refund.",
                "order_reference": "ORDER-123",
            }
        )


@pytest.mark.asyncio
async def test_refund_graph_requests_missing_refund_details(
    order_context: OrderContext,
) -> None:
    intent_extractor = FakeRefundIntentExtractor(
        result=RefundIntentExtraction(
            reason_code="UNSPECIFIED",
            scope="UNSPECIFIED",
            selected_item_ids=[],
        )
    )
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        intent_extractor,
    )

    result = await graph.ainvoke(
        {
            "customer_message": "I want a refund.",
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["status"] == "awaiting_refund_details"
    assert result["refund_proposal"].missing_fields == [
        "REFUND_REASON",
        "REFUND_SCOPE",
    ]


@pytest.mark.asyncio
async def test_refund_graph_records_intent_extraction_failure(
    order_context: OrderContext,
) -> None:
    intent_extractor = FakeRefundIntentExtractor(error=RefundIntentExtractionError())
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        intent_extractor,
    )

    result = await graph.ainvoke(
        {
            "customer_message": "Refund my order because it is damaged.",
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["status"] == "intent_extraction_unavailable"
    assert result["error_code"] == "intent_extraction_unavailable"
    assert result["refund_proposal"] is None


@pytest.mark.asyncio
async def test_refund_graph_continues_when_customer_evidence_is_unavailable(
    order_context: OrderContext,
) -> None:
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        customer_evidence_lookup=FakeCustomerEvidenceLookup(
            error=CustomerEvidenceLookupUnavailableError()
        ),
    )

    result = await graph.ainvoke(
        {
            "customer_message": "Refund my damaged order.",
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["status"] == "refund_proposal_ready"
    assert result["knowledge_evidence"] == []
    assert result["knowledge_retrieval_status"] == "unavailable"


@pytest.mark.asyncio
async def test_refund_graph_propagates_customer_evidence_authorization_failure(
    order_context: OrderContext,
) -> None:
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        customer_evidence_lookup=FakeCustomerEvidenceLookup(
            error=CustomerEvidenceLookupUnauthorizedError()
        ),
    )

    with pytest.raises(CustomerEvidenceLookupUnauthorizedError):
        await graph.ainvoke(
            {
                "customer_message": "Refund my damaged order.",
                "order_reference": "ORDER-123",
                "turn_id": "turn-1",
                "trace_id": "trace-1",
            }
        )


@pytest.mark.asyncio
async def test_refund_graph_uses_composer_only_when_rag_evidence_exists(
    order_context: OrderContext,
) -> None:
    evidence_lookup = FakeCustomerEvidenceLookup(
        result=CustomerEvidenceResponse.model_validate(
            {
                "knowledge_release_id": "refund-policy-2026-08-01",
                "evidence": [
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
                ],
            }
        )
    )
    composer = FakeRefundAnswerComposer(
        result=CustomerAnswer(
            message="The refund policy covers damaged items.",
            citations=[
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        )
    )
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        customer_evidence_lookup=evidence_lookup,
        answer_composer=composer,
    )

    result = await graph.ainvoke(
        {
            "customer_message": "Refund my damaged order.",
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["answer_composition_status"] == "generated"
    assert result["customer_answer"].citations[0].chunk_id == ("section-003-chunk-001")
    assert composer.calls[0]["knowledge_evidence"] == evidence_lookup.result.evidence
    assert composer.calls[0]["order_context"] is order_context


@pytest.mark.asyncio
async def test_refund_graph_falls_back_when_answer_composition_fails(
    order_context: OrderContext,
) -> None:
    evidence_lookup = FakeCustomerEvidenceLookup(
        result=CustomerEvidenceResponse.model_validate(
            {
                "knowledge_release_id": "refund-policy-2026-08-01",
                "evidence": [
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
                ],
            }
        )
    )
    graph, _ = create_graph(
        FakeOrderLookup(result=order_context),
        customer_evidence_lookup=evidence_lookup,
        answer_composer=FakeRefundAnswerComposer(error=RefundAnswerCompositionError()),
    )

    result = await graph.ainvoke(
        {
            "customer_message": "Refund my damaged order.",
            "order_reference": "ORDER-123",
            "turn_id": "turn-1",
            "trace_id": "trace-1",
        }
    )

    assert result["answer_composition_status"] == "fallback"
    assert result["customer_answer"].citations == []
    assert "order ORDER-123" in result["customer_answer"].message


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "model_message",
    ["We will review order 3.", "The proposed refund amount is 167,880 USD."],
)
async def test_answer_node_falls_back_to_trusted_reference_after_wrong_model_order(
    order_context: OrderContext,
    model_message: str,
) -> None:
    order_context = order_context.model_copy(
        update={
            "reference": "AVV8JSZH8G6ZZDMX",
            "total": order_context.total.model_copy(update={"amount_minor": 167880}),
        }
    )
    proposal = create_proposal_builder().build(
        extraction=RefundIntentExtraction(
            reason_code="DAMAGED", scope="FULL_ORDER", selected_item_ids=[]
        ),
        order_context=order_context,
        turn_id="turn-1",
        trace_id="trace-1",
    )

    class WrongOrderModel:
        def with_structured_output(self, *args, **kwargs):
            return self

        async def ainvoke(self, messages):
            return {"message": model_message, "citations": []}

    compose_answer = create_compose_customer_answer_node(
        LangChainRefundAnswerComposer(WrongOrderModel())  # type: ignore[arg-type]
    )
    result = await compose_answer(
        {
            "customer_message": "The item arrived damaged. Refund item 3.",
            "order_reference": "untrusted-request-reference",
            "order_context": order_context,
            "refund_proposal": proposal,
            "knowledge_evidence": [
                CustomerEvidence.model_validate(
                    {
                        "knowledge_document_id": "refund-policy-current",
                        "chunk_id": "section-003-chunk-001",
                        "content": "Damaged items need review.",
                        "citation": {
                            "source_uri": "s3://cso-knowledge/refund-policy.md",
                            "title": "Refund Policy",
                            "section_path": ["Refund eligibility"],
                        },
                        "retrieval_methods": ["semantic_vector"],
                        "reranker_rank": 1,
                    }
                )
            ],
        }
    )

    assert result["answer_composition_status"] == "fallback"
    assert result["customer_answer"].message == (
        "I have captured your refund request for order AVV8JSZH8G6ZZDMX. "
        "We will now continue with the next processing step.\n\n"
        "Proposed refund amount: USD 1,678.80. "
        "This is a request, not a refund approval."
    )
    assert result["customer_answer"].citations == []
    assert proposal.intent.order_id == "3"
    assert proposal.intent.requested_amount.amount_minor == 167880
