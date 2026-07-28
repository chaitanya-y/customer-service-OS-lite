from fastapi.testclient import TestClient

from agent_runtime.integrations.order_lookup import (
    McpOrderLookupClient,
    OrderContext,
)
from agent_runtime.main import app

client = TestClient(app)


def test_refund_intake(
    monkeypatch,
    order_context: OrderContext,
) -> None:
    async def fake_lookup_order(
        _client: McpOrderLookupClient,
        order_reference: str,
    ) -> OrderContext:
        assert order_reference == "ORDER-123"
        return order_context

    monkeypatch.setattr(
        McpOrderLookupClient,
        "lookup_order",
        fake_lookup_order,
    )

    response = client.post(
        "/refunds/intake",
        json={
            "customer_message": "  I want a refund.  ",
            "order_reference": "  ORDER-123  ",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["customer_message"] == "I want a refund."
    assert body["order_reference"] == "ORDER-123"
    assert body["journey"] == "refund"
    assert body["status"] == "order_context_loaded"
    assert body["order_context"]["reference"] == "ORDER-123"
    assert body["order_context"]["customerRef"] == {"customerId": "customer-42"}


def test_refund_intake_rejects_empty_message() -> None:
    response = client.post(
        "/refunds/intake",
        json={"customer_message": "   "},
    )

    assert response.status_code == 422
