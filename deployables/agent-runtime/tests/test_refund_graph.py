from datetime import UTC, datetime

import pytest

from agent_runtime.integrations.order_lookup import (
    OrderContext,
    OrderLookupUnauthorizedError,
    OrderLookupUnavailableError,
    OrderNotFoundError,
)
from agent_runtime.refund.graph import build_refund_graph
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

    async def extract(
        self,
        *,
        customer_message: str,
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        self.messages.append(customer_message)

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
):
    extractor = intent_extractor or FakeRefundIntentExtractor()
    return (
        build_refund_graph(
            order_lookup,
            extractor,
            create_proposal_builder(),
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


@pytest.mark.asyncio
async def test_refund_graph_requests_missing_order_reference() -> None:
    order_lookup = FakeOrderLookup()
    graph, intent_extractor = create_graph(order_lookup)

    result = await graph.ainvoke({"customer_message": "I want a refund."})

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": None,
        "journey": "refund",
        "status": "awaiting_order_reference",
    }
    assert order_lookup.references == []
    assert intent_extractor.messages == []


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
