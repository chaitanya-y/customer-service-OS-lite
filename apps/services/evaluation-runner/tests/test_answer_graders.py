import asyncio

import pytest

from evaluation_runner.answer_graders import (
    AnswerGraderError,
    ExpectedAnswerEvidenceGrader,
    MinimumCitationCountGrader,
    ProhibitedClaimGrader,
)
from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
)


def make_case() -> EvaluationCase:
    return EvaluationCase(
        case_id="damaged-item-answer-v1",
        name="Damaged item answer",
        capability=EvaluationCapability.ANSWER,
        input={"user_input": "What evidence is required?"},
        expectations={
            "reference": "Photo evidence is required before approval.",
            "expected_evidence": [
                {
                    "knowledge_document_id": "refund-policy-current-2026-08-01",
                    "chunk_id": "section-003-chunk-001",
                }
            ],
            "minimum_citation_count": 1,
            "prohibited_claims": ["Your refund is approved"],
        },
    )


def make_sample(
    *,
    response: str = "Please provide damage photos before review.",
    evidence: list[dict] | None = None,
    citations: list[dict] | None = None,
) -> EvaluationSample:
    return EvaluationSample(
        output={
            "response": response,
            "retrieved_contexts": ["Photo evidence is required before approval."],
            "retrieved_evidence": evidence
            if evidence is not None
            else [
                {
                    "rank": 1,
                    "knowledge_document_id": "refund-policy-current-2026-08-01",
                    "chunk_id": "section-003-chunk-001",
                    "content_sha256": "a" * 64,
                    "classification": "CUSTOMER_SAFE",
                }
            ],
            "citations": citations
            if citations is not None
            else [
                {
                    "knowledge_document_id": "refund-policy-current-2026-08-01",
                    "chunk_id": "section-003-chunk-001",
                }
            ],
        },
        final_state={"answer_completed": True},
        latency_ms=1,
        versions={"answer": "v1"},
    )


def test_expected_evidence_grader_uses_document_scoped_identity() -> None:
    grader = ExpectedAnswerEvidenceGrader(blocking=False)
    wrong_document = make_sample(
        evidence=[
            {
                "rank": 1,
                "knowledge_document_id": "different-document",
                "chunk_id": "section-003-chunk-001",
                "content_sha256": "b" * 64,
                "classification": "CUSTOMER_SAFE",
            }
        ]
    )

    result = asyncio.run(grader.grade(make_case(), wrong_document))

    assert result.passed is False
    assert result.blocking is False
    assert result.score == 0
    assert result.details["missing_evidence"] == [
        {
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
        }
    ]


def test_minimum_citation_count_grader_reports_missing_citation() -> None:
    result = asyncio.run(
        MinimumCitationCountGrader(blocking=False).grade(
            make_case(),
            make_sample(citations=[]),
        )
    )

    assert result.passed is False
    assert result.score == 0
    assert result.details == {"minimum": 1, "observed": 0}


def test_prohibited_claim_grader_is_a_blocking_exact_phrase_guard() -> None:
    result = asyncio.run(
        ProhibitedClaimGrader().grade(
            make_case(),
            make_sample(response="Good news: YOUR REFUND IS APPROVED today."),
        )
    )

    assert result.passed is False
    assert result.blocking is True
    assert result.details["matched_claims"] == ["Your refund is approved"]


@pytest.mark.parametrize(
    ("grader", "expectations", "message"),
    [
        (ExpectedAnswerEvidenceGrader(), {"expected_evidence": []}, "non-empty"),
        (MinimumCitationCountGrader(), {"minimum_citation_count": -1}, "non-negative"),
        (ProhibitedClaimGrader(), {"prohibited_claims": [""]}, "non-blank"),
    ],
)
def test_answer_graders_reject_malformed_expectations(
    grader,
    expectations: dict,
    message: str,
) -> None:
    case = make_case().model_copy(update={"expectations": expectations})

    with pytest.raises(AnswerGraderError, match=message):
        asyncio.run(grader.grade(case, make_sample()))
