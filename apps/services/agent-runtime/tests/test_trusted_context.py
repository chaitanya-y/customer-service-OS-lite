import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest

from agent_runtime.integrations.trusted_context import (
    AgentRuntimeContextAssertionError,
    HmacAgentRuntimeContextVerifier,
)

TEST_NOW = datetime(2026, 8, 13, 12, 0, tzinfo=UTC)
TEST_SECRET = "agent-runtime-context-secret-at-least-32-bytes"
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY_ROOT / "packages" / "refund-policy" / "releases.json"


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
    refund_policy: dict[str, str] | None = None,
) -> str:
    claims = {
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
    }
    if refund_policy is not None:
        claims["refundPolicy"] = refund_policy
    return jwt.encode(
        claims,
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
        "refund_policy": None,
    }


def test_verifies_a_signed_refund_policy_binding_after_context_authentication() -> None:
    digest = hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest()
    verified_context = make_verifier().verify(
        make_assertion(
            refund_policy={
                "policyVersion": "refund-policy-v1",
                "catalogSha256": digest,
            }
        )
    )

    assert verified_context.refund_policy is not None
    assert verified_context.refund_policy.model_dump() == {
        "policy_version": "refund-policy-v1",
        "catalog_sha256": digest,
        "currency": "USD",
        "automatic_maximum_minor": 10_000,
        "approval_maximum_minor": 50_000,
    }


@pytest.mark.parametrize(
    "refund_policy, error_code",
    [
        (
            {
                "policyVersion": "refund-policy-unknown",
                "catalogSha256": hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest(),
            },
            "UNKNOWN_REFUND_POLICY_VERSION",
        ),
        (
            {
                "policyVersion": "refund-policy-v1",
                "catalogSha256": "0" * 64,
            },
            "REFUND_POLICY_CATALOG_HASH_MISMATCH",
        ),
    ],
)
def test_rejects_unresolvable_policy_bindings(
    refund_policy: dict[str, str], error_code: str
) -> None:
    with pytest.raises(AgentRuntimeContextAssertionError) as raised:
        make_verifier().verify(make_assertion(refund_policy=refund_policy))

    assert raised.value.__cause__ is not None
    assert error_code in str(raised.value.__cause__)


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
