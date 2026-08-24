import pytest

from agent_runtime.integrations.order_lookup import OrderContext


@pytest.fixture
def order_context() -> OrderContext:
    return OrderContext.model_validate(
        {
            "schemaVersion": "1",
            "observationId": "observation-1",
            "observedAt": "2026-07-26T12:00:00.000Z",
            "source": {
                "provider": "vendure",
                "orderId": "3",
                "factsVersion": f"sha256:{'a' * 64}",
            },
            "reference": "ORDER-123",
            "status": "Delivered",
            "active": False,
            "placedAt": "2026-07-25T23:59:40.265Z",
            "customerRef": {
                "customerId": "customer-42",
            },
            "total": {
                "amountMinor": 10_000,
                "currency": "USD",
            },
            "items": [
                {
                    "itemId": "item-1",
                    "sku": "BLUE-SHIRT",
                    "name": "Blue Shirt",
                    "quantity": 1,
                    "unitPrice": {
                        "amountMinor": 10_000,
                        "currency": "USD",
                    },
                    "lineTotal": {
                        "amountMinor": 10_000,
                        "currency": "USD",
                    },
                }
            ],
            "payments": [],
            "fulfillments": [],
        }
    )
