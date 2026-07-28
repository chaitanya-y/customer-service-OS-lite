from fastapi import APIRouter

from agent_runtime.refund.graph import refund_graph
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
) -> RefundIntakeResponse:
    result = await refund_graph.ainvoke(request.model_dump())

    return RefundIntakeResponse.model_validate(result)
