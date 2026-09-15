from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from agent_runtime.integrations.order_lookup import Money
from agent_runtime.refund.policy import VerifiedRefundPolicy
from agent_runtime.refund.proposal import MissingField, ProposalScope

if TYPE_CHECKING:
    from agent_runtime.refund.answer import CustomerAnswer, KnowledgeCitation


AnswerPurpose = Literal[
    "refund_request",
    "missing_details",
    "amount_review",
    "provider_timing",
    "policy_question",
]

AMOUNT_REVIEW_CONTEXT_REQUIRED = (
    "I can explain the applicable amount-review path once the refund amount "
    "and request details are available."
)


def format_requested_amount(amount: Money | None) -> str | None:
    """Format trusted USD minor units without floating-point arithmetic."""
    if amount is None or amount.currency != "USD":
        return None
    dollars, cents = divmod(amount.amount_minor, 100)
    return f"USD {dollars:,}.{cents:02d}"


def _format_policy_amount(amount_minor: int) -> str:
    dollars, cents = divmod(amount_minor, 100)
    if cents == 0:
        return f"${dollars:,}"
    return f"${dollars:,}.{cents:02d}"


def _public_answer(
    *, message: str, citations: list[KnowledgeCitation]
) -> CustomerAnswer:
    from agent_runtime.refund.answer import CustomerAnswer

    return CustomerAnswer(message=message, citations=citations)


def append_requested_amount(
    answer: CustomerAnswer, amount: Money | None
) -> CustomerAnswer:
    display_amount = format_requested_amount(amount)
    if display_amount is None:
        return _public_answer(
            message=answer.message,
            citations=list(answer.citations),
        )
    return _public_answer(
        message=f"{answer.message}\n\nProposed refund: {display_amount}.",
        citations=list(answer.citations),
    )


def render_customer_answer(
    answer: CustomerAnswer,
    *,
    purpose: AnswerPurpose,
    requested_amount: Money | None,
    proposal_scope: ProposalScope,
    missing_fields: list[MissingField],
    refund_policy: VerifiedRefundPolicy | None,
) -> CustomerAnswer:
    """Apply trusted presentation only after raw model output passes its guards."""
    if purpose != "amount_review":
        public_answer = _public_answer(
            message=answer.message,
            citations=list(answer.citations),
        )
        if purpose == "refund_request":
            return append_requested_amount(public_answer, requested_amount)
        return public_answer

    if (
        refund_policy is None
        or requested_amount is None
        or requested_amount.amount_minor <= 0
        or requested_amount.currency != refund_policy.currency
        or proposal_scope == "UNSPECIFIED"
        or bool(missing_fields)
    ):
        return _public_answer(message=AMOUNT_REVIEW_CONTEXT_REQUIRED, citations=[])

    amount_minor = requested_amount.amount_minor
    amount = _format_policy_amount(amount_minor)
    automatic_maximum = _format_policy_amount(refund_policy.automatic_maximum_minor)
    approval_maximum = _format_policy_amount(refund_policy.approval_maximum_minor)
    if amount_minor > refund_policy.approval_maximum_minor:
        message = (
            f"Your requested refund of {amount} is above the {approval_maximum} "
            "specialist-review threshold, so it requires specialist review before "
            "it can be approved."
        )
    elif amount_minor > refund_policy.automatic_maximum_minor:
        message = (
            f"Your requested refund of {amount} is above the {automatic_maximum} "
            "automatic-approval limit and at or below the "
            f"{approval_maximum} specialist-review threshold, so it requires "
            "human approval."
        )
    else:
        message = (
            f"Your requested refund of {amount} is at or below the "
            f"{automatic_maximum} automatic-approval limit. Automatic approval "
            "is possible only after eligibility and evidence checks."
        )
    return _public_answer(message=message, citations=[])
