from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status

from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    McpOrderLookupClient,
    OrderLookupUnauthorizedError,
)
from agent_runtime.refund.graph import build_refund_graph
from agent_runtime.refund.schemas import (
    RefundIntakeRequest,
    RefundIntakeResponse,
)

router = APIRouter(prefix="/refunds", tags=["refunds"])


@router.post(
    "/intake",
    response_model=RefundIntakeResponse,
    response_model_exclude_none=True,
)
async def intake_refund(
    request: RefundIntakeRequest,
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
        McpOrderLookupClient(context_assertion=context_assertion)
    )

    try:
        result = await graph.ainvoke(request.model_dump())
    except OrderLookupUnauthorizedError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": error.code,
                "message": str(error),
            },
        ) from error

    return RefundIntakeResponse.model_validate(result)
