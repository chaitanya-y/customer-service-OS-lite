from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status

from agent_runtime.config import (
    ConfiguredRefundIntentExtractor,
    RefundProposalSettings,
)
from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    McpOrderLookupClient,
    OrderLookupUnauthorizedError,
)
from agent_runtime.refund.graph import build_refund_graph
from agent_runtime.refund.intent import RefundIntentExtractor
from agent_runtime.refund.proposal import RefundProposalBuilder
from agent_runtime.refund.schemas import (
    RefundIntakeRequest,
    RefundIntakeResponse,
)

router = APIRouter(prefix="/refunds", tags=["refunds"])
configured_intent_extractor = ConfiguredRefundIntentExtractor()


def get_refund_intent_extractor() -> RefundIntentExtractor:
    return configured_intent_extractor


def get_refund_proposal_builder() -> RefundProposalBuilder:
    return RefundProposalBuilder(
        versions=RefundProposalSettings().to_versions(),
    )


@router.post(
    "/intake",
    response_model=RefundIntakeResponse,
    response_model_exclude_none=True,
)
async def intake_refund(
    request: RefundIntakeRequest,
    intent_extractor: Annotated[
        RefundIntentExtractor,
        Depends(get_refund_intent_extractor),
    ],
    proposal_builder: Annotated[
        RefundProposalBuilder,
        Depends(get_refund_proposal_builder),
    ],
    context_assertion: Annotated[
        str | None,
        Header(alias=CONTEXT_ASSERTION_HEADER),
    ] = None,
) -> RefundIntakeResponse:
    if not context_assertion or len(context_assertion) > 8_192:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            },
        )

    graph = build_refund_graph(
        McpOrderLookupClient(context_assertion=context_assertion),
        intent_extractor,
        proposal_builder,
    )

    try:
        result = await graph.ainvoke(
            {
                **request.model_dump(),
                "turn_id": str(uuid4()),
                "trace_id": str(uuid4()),
            }
        )
    except OrderLookupUnauthorizedError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": error.code,
                "message": str(error),
            },
        ) from error

    return RefundIntakeResponse.model_validate(result)
