from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from .models import EvaluationCase, EvaluationSample, GraderResult


class AnswerGraderError(ValueError):
    """Raised when deterministic answer-grading evidence is malformed."""


class PolicyAnswerBand(StrEnum):
    AUTOMATIC_APPROVAL = "AUTOMATIC_APPROVAL"
    HUMAN_APPROVAL = "HUMAN_APPROVAL"
    SPECIALIST_REVIEW = "SPECIALIST_REVIEW"


@dataclass(frozen=True)
class ReviewedPolicyAnswer:
    policy_version: str
    currency: str
    amount_minor: int
    automatic_maximum_minor: int
    approval_maximum_minor: int
    band: PolicyAnswerBand
    response: str


@dataclass(frozen=True)
class PolicyAnswerAuthority:
    """Live-only resolved policy evidence projected into the core grader."""

    expectation: ReviewedPolicyAnswer
    catalog_sha256: str

    def __post_init__(self) -> None:
        if (
            len(self.catalog_sha256) != 64
            or self.catalog_sha256 != self.catalog_sha256.lower()
            or any(
                character not in "0123456789abcdef" for character in self.catalog_sha256
            )
        ):
            raise AnswerGraderError("catalog_sha256 must be a lowercase SHA-256")


def read_reviewed_policy_answer(case: EvaluationCase) -> ReviewedPolicyAnswer:
    raw = case.expectations.get("reviewed_policy_answer")
    if not isinstance(raw, dict):
        raise AnswerGraderError("reviewed_policy_answer must be an object")
    expected_fields = {
        "policy_version",
        "currency",
        "amount_minor",
        "automatic_maximum_minor",
        "approval_maximum_minor",
        "band",
        "response",
    }
    if set(raw) != expected_fields:
        raise AnswerGraderError(
            "reviewed_policy_answer must contain exactly the reviewed policy fields"
        )

    policy_version = _read_non_blank_string(raw["policy_version"], "policy_version")
    currency = _read_non_blank_string(raw["currency"], "currency")
    if currency != "USD":
        raise AnswerGraderError("reviewed policy answer currency must be USD")
    amount_minor = _read_positive_integer(raw["amount_minor"], "amount_minor")
    automatic_maximum_minor = _read_non_negative_integer(
        raw["automatic_maximum_minor"], "automatic_maximum_minor"
    )
    approval_maximum_minor = _read_non_negative_integer(
        raw["approval_maximum_minor"], "approval_maximum_minor"
    )
    if automatic_maximum_minor > approval_maximum_minor:
        raise AnswerGraderError("reviewed policy answer limits are not ordered")
    try:
        band = PolicyAnswerBand(raw["band"])
    except (TypeError, ValueError) as error:
        raise AnswerGraderError("reviewed policy answer band is unsupported") from error
    response = _read_non_blank_string(raw["response"], "response")
    if case.expectations.get("reference") != response:
        raise AnswerGraderError(
            "reviewed policy answer response must equal the reviewed reference"
        )
    return ReviewedPolicyAnswer(
        policy_version=policy_version,
        currency=currency,
        amount_minor=amount_minor,
        automatic_maximum_minor=automatic_maximum_minor,
        approval_maximum_minor=approval_maximum_minor,
        band=band,
        response=response,
    )


def policy_answer_band(
    *, amount_minor: int, automatic_maximum_minor: int, approval_maximum_minor: int
) -> PolicyAnswerBand:
    if amount_minor <= automatic_maximum_minor:
        return PolicyAnswerBand.AUTOMATIC_APPROVAL
    if amount_minor <= approval_maximum_minor:
        return PolicyAnswerBand.HUMAN_APPROVAL
    return PolicyAnswerBand.SPECIALIST_REVIEW


class ReviewedPolicyAnswerGrader:
    """Block policy answers that diverge from independently reviewed authority."""

    name = "answer-reviewed-policy"
    version = "v1"

    def __init__(self, *, authority: PolicyAnswerAuthority) -> None:
        self._authority = authority

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        expected = read_reviewed_policy_answer(case)
        if expected != self._authority.expectation:
            raise AnswerGraderError(
                "reviewed policy answer does not match preflight authority"
            )

        reasons: list[str] = []
        observed_policy_version = sample.versions.get("refund_policy")
        if observed_policy_version != expected.policy_version:
            reasons.append(
                "Observed policy version does not match reviewed policy version."
            )
        observed_catalog_sha256 = sample.versions.get("refund_policy_catalog_sha256")
        if observed_catalog_sha256 != self._authority.catalog_sha256:
            reasons.append(
                "Observed policy catalog hash does not match resolved catalog hash."
            )

        system_context = case.input.get("system_context")
        observed_input_amount = (
            system_context.get("requested_amount_minor")
            if isinstance(system_context, dict)
            else None
        )
        if observed_input_amount != expected.amount_minor:
            reasons.append("Case input does not match reviewed policy-answer amount.")

        raw_facts = sample.output.get("application_facts")
        facts = raw_facts if isinstance(raw_facts, list) else []
        required_facts = {
            "amount fact": (
                "Proposed refund amount: ",
                f"Proposed refund amount: {_format_policy_fact_amount(expected.currency, expected.amount_minor)}.",
            ),
            "automatic-limit fact": (
                "Automatic-approval limit: ",
                f"Automatic-approval limit: {_format_policy_fact_amount(expected.currency, expected.automatic_maximum_minor)}.",
            ),
            "specialist-threshold fact": (
                "Specialist-review threshold: ",
                f"Specialist-review threshold: {_format_policy_fact_amount(expected.currency, expected.approval_maximum_minor)}.",
            ),
        }
        for label, (prefix, required_fact) in required_facts.items():
            matching_facts = [
                fact
                for fact in facts
                if isinstance(fact, str) and fact.startswith(prefix)
            ]
            if matching_facts != [required_fact]:
                reasons.append(
                    f"Trusted application {label} does not match reviewed policy authority."
                )

        response = sample.output.get("response")
        if response != expected.response:
            reasons.append("Answer does not match the exact reviewed response.")

        citations = sample.output.get("citations")
        if citations != []:
            reasons.append(
                "Application-owned policy answer must contain zero citations."
            )

        passed = not reasons
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=True,
            reasons=reasons,
            details={
                "expected_policy_version": expected.policy_version,
                "observed_policy_version": observed_policy_version,
                "expected_catalog_sha256": self._authority.catalog_sha256,
                "observed_catalog_sha256": observed_catalog_sha256,
                "expected_band": expected.band.value,
                "expected_amount_minor": expected.amount_minor,
            },
        )


class ExpectedAnswerEvidenceGrader:
    """Check exact document-and-chunk identities selected by the answer system."""

    name = "answer-expected-evidence"
    version = "v1"

    def __init__(self, *, blocking: bool = False) -> None:
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        expected = _read_identity_list(
            case.expectations.get("expected_evidence"),
            owner="expected_evidence",
            require_non_empty=True,
        )
        observed = _read_identity_list(
            sample.output.get("retrieved_evidence"),
            owner="retrieved_evidence",
            require_non_empty=True,
        )
        observed_keys = {
            (item["knowledge_document_id"], item["chunk_id"]) for item in observed
        }
        missing = [
            item
            for item in expected
            if (item["knowledge_document_id"], item["chunk_id"]) not in observed_keys
        ]
        matched_count = len(expected) - len(missing)
        score = matched_count / len(expected)
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=score,
            passed=not missing,
            blocking=self._blocking,
            reasons=(
                []
                if not missing
                else [f"Missing {len(missing)} reviewed evidence item(s)."]
            ),
            details={
                "expected_count": len(expected),
                "matched_count": matched_count,
                "missing_evidence": missing,
            },
        )


class MinimumCitationCountGrader:
    """Check that the structured answer includes enough retrieved citations."""

    name = "answer-minimum-citations"
    version = "v1"

    def __init__(self, *, blocking: bool = False) -> None:
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        minimum = case.expectations.get("minimum_citation_count")
        if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 0:
            raise AnswerGraderError(
                "minimum_citation_count must be a non-negative integer"
            )

        citations = _read_identity_list(
            sample.output.get("citations"),
            owner="citations",
            require_non_empty=False,
        )
        observed = len(citations)
        passed = observed >= minimum
        score = 1.0 if minimum == 0 else min(observed / minimum, 1.0)
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=score,
            passed=passed,
            blocking=self._blocking,
            reasons=(
                []
                if passed
                else [
                    f"Answer has {observed} citation(s); at least {minimum} required."
                ]
            ),
            details={"minimum": minimum, "observed": observed},
        )


class ProhibitedClaimGrader:
    """Reject reviewed literal promise phrases before semantic grading."""

    name = "answer-prohibited-claim"
    version = "v1"

    def __init__(self, *, blocking: bool = True) -> None:
        self._blocking = blocking

    async def grade(
        self,
        case: EvaluationCase,
        sample: EvaluationSample,
    ) -> GraderResult:
        configured_claims = case.expectations.get("prohibited_claims")
        if (
            not isinstance(configured_claims, list)
            or not configured_claims
            or any(
                not isinstance(claim, str) or not claim.strip()
                for claim in configured_claims
            )
        ):
            raise AnswerGraderError(
                "prohibited_claims must be a non-empty list of non-blank strings"
            )
        if len(set(configured_claims)) != len(configured_claims):
            raise AnswerGraderError("prohibited_claims must not contain duplicates")

        response = sample.output.get("response")
        if not isinstance(response, str) or not response.strip():
            raise AnswerGraderError("response must be a non-blank string")

        normalized_response = response.casefold()
        matched_claims = [
            claim
            for claim in configured_claims
            if claim.casefold() in normalized_response
        ]
        passed = not matched_claims
        return GraderResult(
            grader_name=self.name,
            grader_version=self.version,
            score=1.0 if passed else 0.0,
            passed=passed,
            blocking=self._blocking,
            reasons=(
                []
                if passed
                else [
                    f"Answer contains prohibited claim: {claim}."
                    for claim in matched_claims
                ]
            ),
            details={"matched_claims": matched_claims},
        )


def _read_non_blank_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnswerGraderError(f"{field} must be a non-blank string")
    return value


def _read_non_negative_integer(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise AnswerGraderError(f"{field} must be a non-negative integer")
    return value


def _read_positive_integer(value: object, field: str) -> int:
    value = _read_non_negative_integer(value, field)
    if value == 0:
        raise AnswerGraderError(f"{field} must be a positive integer")
    return value


def _format_policy_fact_amount(currency: str, amount_minor: int) -> str:
    dollars, cents = divmod(amount_minor, 100)
    return f"{currency} {dollars:,}.{cents:02d}"


def _read_identity_list(
    value: object,
    *,
    owner: str,
    require_non_empty: bool,
) -> list[dict[str, str]]:
    if not isinstance(value, list) or (require_non_empty and not value):
        requirement = "non-empty " if require_non_empty else ""
        raise AnswerGraderError(f"{owner} must be a {requirement}list")

    identities: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise AnswerGraderError(f"{owner} items must be objects")
        document_id = item.get("knowledge_document_id")
        chunk_id = item.get("chunk_id")
        if (
            not isinstance(document_id, str)
            or not document_id.strip()
            or not isinstance(chunk_id, str)
            or not chunk_id.strip()
        ):
            raise AnswerGraderError(
                f"{owner} items require non-blank document and chunk IDs"
            )
        identities.append(
            {
                "knowledge_document_id": document_id,
                "chunk_id": chunk_id,
            }
        )

    keys = [(item["knowledge_document_id"], item["chunk_id"]) for item in identities]
    if len(keys) != len(set(keys)):
        raise AnswerGraderError(f"{owner} must not contain duplicate identities")
    return identities
