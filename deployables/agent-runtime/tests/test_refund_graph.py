import pytest

from agent_runtime.integrations.order_lookup import (
    OrderContext,
    OrderLookupUnavailableError,
    OrderNotFoundError,
)
from agent_runtime.refund.graph import build_refund_graph


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


@pytest.mark.asyncio
async def test_refund_graph_loads_order_context(
    order_context: OrderContext,
) -> None:
    order_lookup = FakeOrderLookup(result=order_context)
    graph = build_refund_graph(order_lookup)

    result = await graph.ainvoke(
        {
            "customer_message": "  I want a refund.  ",
            "order_reference": "  ORDER-123  ",
        }
    )

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": "ORDER-123",
        "order_context": order_context,
        "error_code": None,
        "journey": "refund",
        "status": "order_context_loaded",
    }
    assert order_lookup.references == ["ORDER-123"]


@pytest.mark.asyncio
async def test_refund_graph_requests_missing_order_reference() -> None:
    order_lookup = FakeOrderLookup()
    graph = build_refund_graph(order_lookup)

    result = await graph.ainvoke({"customer_message": "I want a refund."})

    assert result == {
        "customer_message": "I want a refund.",
        "order_reference": None,
        "journey": "refund",
        "status": "awaiting_order_reference",
    }
    assert order_lookup.references == []


@pytest.mark.asyncio
async def test_refund_graph_records_order_not_found() -> None:
    graph = build_refund_graph(FakeOrderLookup(error=OrderNotFoundError()))

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
    graph = build_refund_graph(FakeOrderLookup(error=OrderLookupUnavailableError()))

    result = await graph.ainvoke(
        {
            "customer_message": "I want a refund.",
            "order_reference": "ORDER-123",
        }
    )

    assert result["status"] == "order_lookup_unavailable"
    assert result["error_code"] == "order_lookup_unavailable"
    assert result["order_context"] is None
