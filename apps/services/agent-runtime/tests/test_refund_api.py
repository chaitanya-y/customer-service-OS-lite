import pytest
from fastapi.testclient import TestClient

from agent_runtime.integrations.customer_evidence import (
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
    CustomerEvidenceResponse,
    KnowledgeRagCustomerEvidenceClient,
)
from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    McpOrderLookupClient,
    OrderContext,
    OrderLookupUnauthorizedError,
)
from agent_runtime.integrations.trusted_context import (
    AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
    VerifiedAgentRuntimeContext,
)
from agent_runtime.main import app
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.refund.graph import MISSING_ORDER_REFERENCE_MESSAGE
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import RefundProposalBuilder, RefundProposalVersions
from agent_runtime.refund.router import (
    get_agent_runtime_context_verifier,
    get_refund_intent_extractor,
    get_refund_proposal_builder,
)

client = TestClient(app)
TEST_CONTEXT_ASSERTION = "header.claims.signature"
TEST_AGENT_RUNTIME_CONTEXT_ASSERTION = "agent-runtime.header.signature"
TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION = "knowledge-rag.header.signature"


class FakeRefundIntentExtractor:
    def __init__(self) -> None:
        self.conversation_messages: list[list[ConversationCustomerMessage]] = []

    async def extract(
        self,
        *,
        customer_message: str,
        conversation_messages: list[ConversationCustomerMessage],
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        self.conversation_messages.append(conversation_messages)
        return RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        )


class FakeAgentRuntimeContextVerifier:
    def verify(
        self,
        assertion: str | None,
    ) -> VerifiedAgentRuntimeContext:
        assert assertion == TEST_AGENT_RUNTIME_CONTEXT_ASSERTION

        return VerifiedAgentRuntimeContext(
            context_id="context-1",
            tenant_id="tenant-local",
            environment_id="local",
            subject_customer_id="customer-42",
            request_id="request-1",
            trace_id="trace-1",
            routing_epoch=1,
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
    app.dependency_overrides[get_agent_runtime_context_verifier] = lambda: (
        FakeAgentRuntimeContextVerifier()
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

    async def fake_retrieve_customer_evidence(
        rag_client: KnowledgeRagCustomerEvidenceClient,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        assert rag_client._context_assertion == TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
        assert query_text == "I want a refund."
        return CustomerEvidenceResponse(
            knowledge_release_id="refund-policy-2026-08-01",
            evidence=[],
        )

    monkeypatch.setattr(
        KnowledgeRagCustomerEvidenceClient,
        "retrieve_customer_evidence",
        fake_retrieve_customer_evidence,
    )

    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
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
    assert body["refund_proposal"]["executionEvidence"]["traceId"] == "trace-1"


def test_refund_intake_uses_ordered_customer_only_conversation_context(
    monkeypatch,
    order_context: OrderContext,
) -> None:
    async def fake_lookup_order(
        _client: McpOrderLookupClient,
        order_reference: str,
    ) -> OrderContext:
        assert order_reference == "ORDER-123"
        return order_context

    monkeypatch.setattr(McpOrderLookupClient, "lookup_order", fake_lookup_order)

    async def fake_retrieve_customer_evidence(
        _rag_client: KnowledgeRagCustomerEvidenceClient,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        assert query_text == "The item arrived damaged."
        return CustomerEvidenceResponse(
            knowledge_release_id="refund-policy-2026-08-01",
            evidence=[],
        )

    monkeypatch.setattr(
        KnowledgeRagCustomerEvidenceClient,
        "retrieve_customer_evidence",
        fake_retrieve_customer_evidence,
    )
    extractor = FakeRefundIntentExtractor()
    app.dependency_overrides[get_refund_intent_extractor] = lambda: extractor

    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
        },
        json={
            "customer_message": "The item arrived damaged.",
            "order_reference": "ORDER-123",
            "conversation_messages": [
                {
                    "sequence_number": 1,
                    "text": "My order reference is ORDER-123.",
                },
                {
                    "sequence_number": 3,
                    "text": "The item arrived damaged.",
                },
            ],
        },
    )

    assert response.status_code == 200
    assert extractor.conversation_messages == [
        [
            ConversationCustomerMessage(
                sequence_number=1,
                text="My order reference is ORDER-123.",
            ),
            ConversationCustomerMessage(
                sequence_number=3,
                text="The item arrived damaged.",
            ),
        ]
    ]


def test_refund_intake_rejects_inconsistent_conversation_context() -> None:
    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
        },
        json={
            "customer_message": "The item arrived damaged.",
            "conversation_messages": [
                {
                    "sequence_number": 1,
                    "text": "A different message.",
                },
            ],
        },
    )

    assert response.status_code == 422


def test_refund_intake_rejects_empty_message() -> None:
    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
        },
        json={"customer_message": "   "},
    )

    assert response.status_code == 422


def test_refund_intake_returns_a_safe_answer_when_order_reference_is_missing() -> None:
    response = client.post(
        "/refunds/intake",
        headers={
            CONTEXT_ASSERTION_HEADER: TEST_CONTEXT_ASSERTION,
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
        },
        json={"customer_message": "I want a refund."},
    )

    assert response.status_code == 200
    assert response.json() == {
        "customer_message": "I want a refund.",
        "customer_answer": {
            "message": MISSING_ORDER_REFERENCE_MESSAGE,
            "citations": [],
        },
        "journey": "refund",
        "status": "awaiting_order_reference",
    }


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
            AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER: (
                TEST_AGENT_RUNTIME_CONTEXT_ASSERTION
            ),
            KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                TEST_KNOWLEDGE_RAG_CONTEXT_ASSERTION
            ),
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
