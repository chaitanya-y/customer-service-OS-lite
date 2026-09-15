from __future__ import annotations

import pytest

from agent_runtime.integrations.order_lookup import Money
from agent_runtime.refund.answer import CustomerAnswer
from agent_runtime.refund.policy import VerifiedRefundPolicy
from agent_runtime.refund.presentation import render_customer_answer

POLICY = VerifiedRefundPolicy(
    policy_version="refund-policy-v1",
    catalog_sha256="a" * 64,
    currency="USD",
    automatic_maximum_minor=10_000,
    approval_maximum_minor=50_000,
)


@pytest.mark.parametrize(
    ("amount_minor", "expected"),
    [
        (
            10_000,
            (
                "Your requested refund of $100 is at or below the $100 "
                "automatic-approval limit. Automatic approval is possible only "
                "after eligibility and evidence checks."
            ),
        ),
        (
            10_001,
            (
                "Your requested refund of $100.01 is above the $100 "
                "automatic-approval limit and at or below the $500 "
                "specialist-review threshold, so it requires human approval."
            ),
        ),
        (
            50_000,
            (
                "Your requested refund of $500 is above the $100 automatic-approval "
                "limit and at or below the $500 specialist-review threshold, so it "
                "requires human approval."
            ),
        ),
        (
            50_001,
            (
                "Your requested refund of $500.01 is above the $500 "
                "specialist-review threshold, so it requires specialist review "
                "before it can be approved."
            ),
        ),
        (
            75_000,
            (
                "Your requested refund of $750 is above the $500 specialist-review "
                "threshold, so it requires specialist review before it can be "
                "approved."
            ),
        ),
    ],
)
def test_amount_review_uses_exact_integer_policy_boundaries(
    amount_minor: int, expected: str
) -> None:
    answer = render_customer_answer(
        CustomerAnswer(
            message="Model guidance that will not be used.",
            citations=[
                {
                    "knowledgeDocumentId": "policy",
                    "chunkId": "chunk-1",
                }
            ],
        ),
        purpose="amount_review",
        requested_amount=Money(amount_minor=amount_minor, currency="USD"),
        proposal_scope="FULL_ORDER",
        missing_fields=[],
        refund_policy=POLICY,
    )

    assert answer.message == expected
    assert answer.citations == []


@pytest.mark.parametrize(
    ("requested_amount", "proposal_scope", "missing_fields", "refund_policy"),
    [
        (None, "FULL_ORDER", [], POLICY),
        (Money(amount_minor=0, currency="USD"), "FULL_ORDER", [], POLICY),
        (Money(amount_minor=12_500, currency="EUR"), "FULL_ORDER", [], POLICY),
        (Money(amount_minor=12_500, currency="USD"), "UNSPECIFIED", [], POLICY),
        (
            Money(amount_minor=12_500, currency="USD"),
            "FULL_ORDER",
            ["REFUND_REASON"],
            POLICY,
        ),
        (Money(amount_minor=12_500, currency="USD"), "FULL_ORDER", [], None),
    ],
)
def test_amount_review_does_not_guess_without_complete_trusted_usd_context(
    requested_amount: Money | None,
    proposal_scope: str,
    missing_fields: list[str],
    refund_policy: VerifiedRefundPolicy | None,
) -> None:
    answer = render_customer_answer(
        CustomerAnswer(message="Unused model guidance.", citations=[]),
        purpose="amount_review",
        requested_amount=requested_amount,
        proposal_scope=proposal_scope,
        missing_fields=missing_fields,
        refund_policy=refund_policy,
    )

    assert answer.message == (
        "I can explain the applicable amount-review path once the refund amount "
        "and request details are available."
    )
    assert answer.citations == []


@pytest.mark.parametrize(
    "purpose",
    ["missing_details", "provider_timing", "policy_question"],
)
def test_non_request_purposes_do_not_append_proposed_money(purpose: str) -> None:
    answer = render_customer_answer(
        CustomerAnswer(message="Relevant cited guidance.", citations=[]),
        purpose=purpose,
        requested_amount=Money(amount_minor=12_500, currency="USD"),
        proposal_scope="FULL_ORDER",
        missing_fields=[],
        refund_policy=POLICY,
    )

    assert answer.message == "Relevant cited guidance."


def test_refund_request_keeps_a_short_application_owned_amount() -> None:
    answer = render_customer_answer(
        CustomerAnswer(message="Relevant cited guidance.", citations=[]),
        purpose="refund_request",
        requested_amount=Money(amount_minor=12_500, currency="USD"),
        proposal_scope="FULL_ORDER",
        missing_fields=[],
        refund_policy=POLICY,
    )

    assert answer.message == "Relevant cited guidance.\n\nProposed refund: USD 125.00."
