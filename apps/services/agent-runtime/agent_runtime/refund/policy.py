from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    ValidationError,
    model_validator,
)

JSON_SAFE_INTEGER_MAX = 9_007_199_254_740_991
SafeNonNegativeInteger = Annotated[
    int, Field(strict=True, ge=0, le=JSON_SAFE_INTEGER_MAX)
]
SafePositiveInteger = Annotated[int, Field(strict=True, gt=0, le=JSON_SAFE_INTEGER_MAX)]


class RefundPolicyBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    policy_version: str = Field(alias="policyVersion", min_length=1)
    catalog_sha256: str = Field(alias="catalogSha256", pattern=r"^[a-f0-9]{64}$")


class VerifiedRefundPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    policy_version: str = Field(min_length=1)
    catalog_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    currency: Literal["USD"]
    automatic_maximum_minor: int = Field(ge=0)
    approval_maximum_minor: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_bounds(self) -> VerifiedRefundPolicy:
        if self.automatic_maximum_minor > self.approval_maximum_minor:
            raise ValueError("automatic maximum exceeds approval maximum")
        return self


class _CatalogRelease(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    policy_version: str = Field(alias="policyVersion", min_length=1)
    supported_currency: Literal["USD"] = Field(alias="supportedCurrency")
    automatic_maximum_minor: SafeNonNegativeInteger = Field(
        alias="automaticMaximumMinor"
    )
    approval_maximum_minor: SafeNonNegativeInteger = Field(alias="approvalMaximumMinor")
    elevated_risk_prior_refund_count: SafeNonNegativeInteger = Field(
        alias="elevatedRiskPriorRefundCount"
    )
    high_risk_prior_refund_count: SafeNonNegativeInteger = Field(
        alias="highRiskPriorRefundCount"
    )
    decision_validity_seconds: SafePositiveInteger = Field(
        alias="decisionValiditySeconds"
    )
    permitted_reason_codes: list[str] = Field(
        alias="permittedReasonCodes", min_length=1
    )
    require_damage_photo: StrictBool | None = Field(
        default=None, alias="requireDamagePhoto"
    )

    @model_validator(mode="after")
    def validate_release(self) -> _CatalogRelease:
        if self.automatic_maximum_minor > self.approval_maximum_minor:
            raise ValueError("automatic maximum exceeds approval maximum")
        if self.elevated_risk_prior_refund_count >= self.high_risk_prior_refund_count:
            raise ValueError("risk limits are not ordered")
        if any(not code for code in self.permitted_reason_codes):
            raise ValueError("empty reason code")
        if len(set(self.permitted_reason_codes)) != len(self.permitted_reason_codes):
            raise ValueError("duplicate reason code")
        if (
            "require_damage_photo" in self.model_fields_set
            and self.require_damage_photo is None
        ):
            raise ValueError("requireDamagePhoto cannot be null")
        return self


class _RefundPolicyCatalog(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    schema_version: Literal["1"] = Field(alias="schemaVersion")
    releases: list[_CatalogRelease] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_versions(self) -> _RefundPolicyCatalog:
        versions = [release.policy_version for release in self.releases]
        if len(set(versions)) != len(versions):
            raise ValueError("duplicate policy version")
        return self


def _default_catalog_path() -> Path:
    return Path(__file__).resolve().parents[5] / "packages/refund-policy/releases.json"


def _read_catalog(
    catalog_path: str | Path | None,
) -> tuple[bytes, _RefundPolicyCatalog]:
    path = Path(catalog_path) if catalog_path is not None else _default_catalog_path()
    try:
        raw_catalog = path.read_bytes()
    except OSError as error:
        raise ValueError("REFUND_POLICY_CATALOG_UNAVAILABLE") from error

    try:
        catalog = _RefundPolicyCatalog.model_validate(json.loads(raw_catalog))
    except (
        json.JSONDecodeError,
        UnicodeDecodeError,
        ValidationError,
        TypeError,
    ) as error:
        raise ValueError("INVALID_REFUND_POLICY_CATALOG") from error
    return raw_catalog, catalog


def verify_refund_policy(
    binding: RefundPolicyBinding,
    *,
    catalog_path: str | Path | None = None,
) -> VerifiedRefundPolicy:
    raw_catalog, catalog = _read_catalog(catalog_path)
    catalog_sha256 = hashlib.sha256(raw_catalog).hexdigest()
    if catalog_sha256 != binding.catalog_sha256:
        raise ValueError("REFUND_POLICY_CATALOG_HASH_MISMATCH")

    release = next(
        (
            candidate
            for candidate in catalog.releases
            if candidate.policy_version == binding.policy_version
        ),
        None,
    )
    if release is None:
        raise ValueError("UNKNOWN_REFUND_POLICY_VERSION")

    return VerifiedRefundPolicy(
        policy_version=release.policy_version,
        catalog_sha256=catalog_sha256,
        currency=release.supported_currency,
        automatic_maximum_minor=release.automatic_maximum_minor,
        approval_maximum_minor=release.approval_maximum_minor,
    )


def resolve_refund_policy(
    version: str, *, catalog_path: str | Path | None = None
) -> VerifiedRefundPolicy:
    raw_catalog, _ = _read_catalog(catalog_path)
    return verify_refund_policy(
        RefundPolicyBinding(
            policyVersion=version,
            catalogSha256=hashlib.sha256(raw_catalog).hexdigest(),
        ),
        catalog_path=catalog_path,
    )
