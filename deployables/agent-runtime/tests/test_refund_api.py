import pytest
from fastapi.testclient import TestClient

from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    McpOrderLookupClient,
    OrderContext,
    OrderLookupUnauthorizedError,
)
from agent_runtime.main import app
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import RefundProposalBuilder, RefundProposalVersions
from agent_runtime.refund.router import (
    get_refund_intent_extractor,
    get_refund_proposal_builder,
)

client = TestClient(app)
TEST_CONTEXT_ASSERTION = "header.claims.signature"


class FakeRefundIntentExtractor:
    async def extract(
        self,
        *,
        customer_message: str,
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        return RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        )


@pytest.fixture(autouse=True)
def refund_dependencies():
    app.dependency_overrides[get_refund_intent_extractor] = lambda: (
        FakeRefundIntentExtractor()
    )
    app.dependency_overrides[get_refund_proposal_builder] = lambda: (
        RefundProposalBuilder(
            versions=RefundProposalVersions(
                agent_release_id="agent-runtime-test",
                prompt_bundle_version="refund-intent-v1",
                model_route_id="refund-intent-test-model",
                knowledge_release_id="knowledge-not-used",
                guardrail_version="refund-proposal-guardrails-v1",
                evaluation_version="refund-proposal-eval-v1",
                order_lookup_tool_version="lookup-order-v1",
            )
        )
    )

    yield

    app.dependency_overrides.clear()


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
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
        },
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
    assert body["status"] == "refund_proposal_ready"
    assert body["order_context"]["reference"] == "ORDER-123"
    assert body["order_context"]["customerRef"] == {"customerId": "customer-42"}
    assert body["refund_proposal"]["resultType"] == "JOURNEY_PROPOSAL"
    assert body["refund_proposal"]["intent"]["orderId"] == "3"
    assert body["refund_proposal"]["missingFields"] == []


def test_refund_intake_rejects_empty_message() -> None:
    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
        },
        json={"customer_message": "   "},
    )

    assert response.status_code == 422


def test_refund_intake_requires_trusted_context() -> None:
    response = client.post(
        "/refunds/intake",
        json={"customer_message": "I want a refund."},
    )

    assert response.status_code == 401
    assert response.json() == {
        "detail": {
            "code": "context_unauthorized",
            "message": "Trusted context is required",
        }
    }


def test_refund_intake_rejects_context_denied_by_gateway(
    monkeypatch,
) -> None:
    async def reject_context(
        _client: McpOrderLookupClient,
        _order_reference: str,
    ) -> OrderContext:
        raise OrderLookupUnauthorizedError()

    monkeypatch.setattr(
        McpOrderLookupClient,
        "lookup_order",
        reject_context,
    )

    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
        },
        json={
            "customer_message": "I want a refund.",
            "order_reference": "ORDER-123",
        },
    )

    assert response.status_code == 401
    assert response.json() == {
        "detail": {
            "code": "context_unauthorized",
            "message": "Trusted context is required",
        }
    }
