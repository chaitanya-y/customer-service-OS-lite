from datetime import UTC, datetime, timedelta

import jwt
import pytest

from knowledge_rag.trusted_context import (
    HmacKnowledgeRagContextVerifier,
    KnowledgeRagContextAssertionError,
)

TEST_SECRET = "knowledge-rag-context-secret-at-least-32-bytes"
NOW = datetime(2026, 8, 14, 12, 0, tzinfo=UTC)


def create_assertion(**overrides: object) -> str:
    issued_at = int(NOW.timestamp())
    payload = {
        "contextVersion": "1",
        "contextId": "context-1",
        "tenant": {
            "tenantId": "tenant-local",
            "environmentId": "local",
        },
        "actor": {
            "kind": "end_customer",
            "principalId": "customer-1",
        },
        "subject": {"customerId": "customer-1"},
        "delegation": {"mode": "self"},
        "purpose": "customer_support",
        "route": {
            "homeRegion": "local",
            "homeCell": "local-cell-1",
            "routingEpoch": 1,
        },
        "request": {
            "requestId": "request-1",
            "traceId": "trace-1",
            "channelId": "web",
        },
        "iss": "customer-service-os-edge",
        "aud": "knowledge-rag",
        "iat": issued_at,
        "exp": issued_at + 60,
    }
    payload.update(overrides)

    return jwt.encode(
        payload,
        TEST_SECRET,
        algorithm="HS256",
        headers={"typ": "cso-context+jwt"},
    )


def create_verifier() -> HmacKnowledgeRagContextVerifier:
    return HmacKnowledgeRagContextVerifier(
        secret=TEST_SECRET,
        expected_issuer="customer-service-os-edge",
        expected_audience="knowledge-rag",
        expected_tenant_id="tenant-local",
        expected_environment_id="local",
        now=lambda: NOW,
    )


def test_verifies_a_valid_knowledge_rag_context_assertion() -> None:
    verified = create_verifier().verify(create_assertion())

    assert verified.model_dump() == {
        "context_id": "context-1",
        "tenant_id": "tenant-local",
        "environment_id": "local",
        "subject_customer_id": "customer-1",
        "request_id": "request-1",
        "trace_id": "trace-1",
        "routing_epoch": 1,
    }


@pytest.mark.parametrize(
    ("assertion", "message"),
    [
        (create_assertion(aud="agent-runtime"), "wrong audience"),
        (
            create_assertion(
                tenant={"tenantId": "acme", "environmentId": "local"}
            ),
            "wrong tenant",
        ),
        (create_assertion(exp=int((NOW - timedelta(seconds=1)).timestamp())), "expired"),
        (
            create_assertion(
                exp=int((NOW + timedelta(seconds=301)).timestamp())
            ),
            "lifetime too long",
        ),
    ],
)
def test_rejects_an_untrusted_context_assertion(
    assertion: str,
    message: str,
) -> None:
    del message

    with pytest.raises(KnowledgeRagContextAssertionError):
        create_verifier().verify(assertion)
