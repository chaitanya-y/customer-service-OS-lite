from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_runtime.refund.policy import RefundPolicyBinding, verify_refund_policy

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY_ROOT / "packages" / "refund-policy" / "releases.json"


def binding(version: str = "refund-policy-v1") -> RefundPolicyBinding:
    digest = hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest()
    return RefundPolicyBinding.model_validate(
        {"policyVersion": version, "catalogSha256": digest}
    )


def test_verifies_the_real_catalog_and_projects_only_public_policy_fields() -> None:
    verified = verify_refund_policy(binding(), catalog_path=CATALOG_PATH)

    assert verified.model_dump() == {
        "policy_version": "refund-policy-v1",
        "catalog_sha256": hashlib.sha256(CATALOG_PATH.read_bytes()).hexdigest(),
        "currency": "USD",
        "automatic_maximum_minor": 10_000,
        "approval_maximum_minor": 50_000,
    }
    assert verified.model_config["frozen"] is True


def test_verifies_v2_without_changing_the_public_monetary_bounds() -> None:
    verified = verify_refund_policy(
        binding("refund-policy-v2"), catalog_path=CATALOG_PATH
    )

    assert verified.policy_version == "refund-policy-v2"
    assert verified.automatic_maximum_minor == 10_000
    assert verified.approval_maximum_minor == 50_000


def test_rejects_a_binding_with_an_altered_catalog_hash() -> None:
    altered = RefundPolicyBinding.model_validate(
        {"policyVersion": "refund-policy-v1", "catalogSha256": "0" * 64}
    )

    with pytest.raises(ValueError, match="REFUND_POLICY_CATALOG_HASH_MISMATCH"):
        verify_refund_policy(altered, catalog_path=CATALOG_PATH)


def test_rejects_an_unknown_bound_version() -> None:
    with pytest.raises(ValueError, match="UNKNOWN_REFUND_POLICY_VERSION"):
        verify_refund_policy(
            binding("refund-policy-unknown"), catalog_path=CATALOG_PATH
        )


def test_rejects_a_malformed_binding_hash_before_catalog_access() -> None:
    with pytest.raises(ValidationError):
        RefundPolicyBinding.model_validate(
            {"policyVersion": "refund-policy-v1", "catalogSha256": "not-a-hash"}
        )


def test_default_catalog_resolution_is_independent_of_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)

    assert verify_refund_policy(binding()).policy_version == "refund-policy-v1"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("automaticMaximumMinor", True),
        ("approvalMaximumMinor", 9_007_199_254_740_992),
        ("decisionValiditySeconds", 900.0),
        ("requireDamagePhoto", None),
    ],
)
def test_rejects_catalog_values_the_node_reader_cannot_represent_exactly(
    tmp_path: Path, field: str, value: object
) -> None:
    release = {
        "policyVersion": "refund-policy-test",
        "supportedCurrency": "USD",
        "automaticMaximumMinor": 10_000,
        "approvalMaximumMinor": 50_000,
        "elevatedRiskPriorRefundCount": 1,
        "highRiskPriorRefundCount": 2,
        "decisionValiditySeconds": 900,
        "permittedReasonCodes": ["DAMAGED"],
        field: value,
    }
    raw_catalog = json.dumps({"schemaVersion": "1", "releases": [release]}).encode()
    catalog_path = tmp_path / "releases.json"
    catalog_path.write_bytes(raw_catalog)
    test_binding = RefundPolicyBinding.model_validate(
        {
            "policyVersion": "refund-policy-test",
            "catalogSha256": hashlib.sha256(raw_catalog).hexdigest(),
        }
    )

    with pytest.raises(ValueError, match="INVALID_REFUND_POLICY_CATALOG"):
        verify_refund_policy(test_binding, catalog_path=catalog_path)
