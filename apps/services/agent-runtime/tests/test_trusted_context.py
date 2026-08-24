from datetime import UTC, datetime, timedelta

import jwt
import pytest

from agent_runtime.integrations.trusted_context import (
    AgentRuntimeContextAssertionError,
    HmacAgentRuntimeContextVerifier,
)

TEST_NOW = datetime(2026, 8, 13, 12, 0, tzinfo=UTC)
TEST_SECRET = "agent-runtime-context-secret-at-least-32-bytes"


def make_verifier(**overrides: str) -> HmacAgentRuntimeContextVerifier:
    options = {
        "secret": TEST_SECRET,
        "expected_issuer": "customer-service-os-edge",
        "expected_audience": "agent-runtime",
        "expected_tenant_id": "tenant-local",
        "expected_environment_id": "local",
        "now": lambda: TEST_NOW,
    }
    options.update(overrides)
    return HmacAgentRuntimeContextVerifier(**options)


def make_assertion(
    *,
    audience: str = "agent-runtime",
    tenant_id: str = "tenant-local",
    environment_id: str = "local",
    principal_id: str = "customer-42",
    customer_id: str = "customer-42",
    issued_at: datetime = TEST_NOW,
    expires_at: datetime = TEST_NOW + timedelta(seconds=60),
    secret: str = TEST_SECRET,
) -> str:
    return jwt.encode(
        {
            "contextVersion": "1",
            "contextId": "context-1",
            "tenant": {
                "tenantId": tenant_id,
                "environmentId": environment_id,
            },
            "actor": {
                "kind": "end_customer",
                "principalId": principal_id,
            },
            "subject": {"customerId": customer_id},
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
            "aud": audience,
            "iat": int(issued_at.timestamp()),
            "exp": int(expires_at.timestamp()),
        },
        secret,
        algorithm="HS256",
        headers={"typ": "cso-context+jwt"},
    )


def test_verifies_an_assertion_intended_for_agent_runtime() -> None:
    verified_context = make_verifier().verify(make_assertion())

    assert verified_context.model_dump() == {
        "context_id": "context-1",
        "tenant_id": "tenant-local",
        "environment_id": "local",
        "subject_customer_id": "customer-42",
        "request_id": "request-1",
        "trace_id": "trace-1",
        "routing_epoch": 1,
    }


@pytest.mark.parametrize(
    "assertion",
    [
        make_assertion(audience="integration-gateway"),
        make_assertion(tenant_id="another-tenant"),
        make_assertion(environment_id="staging"),
        make_assertion(
            issued_at=TEST_NOW - timedelta(seconds=61),
            expires_at=TEST_NOW - timedelta(seconds=1),
        ),
        make_assertion(
            issued_at=TEST_NOW,
            expires_at=TEST_NOW + timedelta(seconds=301),
        ),
        make_assertion(principal_id="customer-99"),
        make_assertion(secret="another-secret-with-at-least-32-bytes"),
    ],
)
def test_rejects_an_untrusted_assertion(assertion: str) -> None:
    with pytest.raises(AgentRuntimeContextAssertionError):
        make_verifier().verify(assertion)


def test_rejects_missing_or_wrong_token_type() -> None:
    with pytest.raises(AgentRuntimeContextAssertionError):
        make_verifier().verify(None)

    assertion = jwt.encode(
        {"sub": "customer-42"},
        TEST_SECRET,
        algorithm="HS256",
        headers={"typ": "JWT"},
    )

    with pytest.raises(AgentRuntimeContextAssertionError):
        make_verifier().verify(assertion)
