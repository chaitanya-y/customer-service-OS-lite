from __future__ import annotations

from .models import EvaluationCase, EvaluationSample, GraderResult


class AnswerGraderError(ValueError):
    """Raised when deterministic answer-grading evidence is malformed."""


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
