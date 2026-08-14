from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status

from agent_runtime.config import (
    AgentRuntimeContextSettings,
    ConfiguredRefundAnswerComposer,
    ConfiguredRefundIntentExtractor,
    KnowledgeRagClientSettings,
    RefundProposalSettings,
)
from agent_runtime.integrations.customer_evidence import (
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
    CustomerEvidenceLookupUnauthorizedError,
    KnowledgeRagCustomerEvidenceClient,
)
from agent_runtime.integrations.order_lookup import (
    CONTEXT_ASSERTION_HEADER,
    McpOrderLookupClient,
    OrderLookupUnauthorizedError,
)
from agent_runtime.integrations.trusted_context import (
    AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
    AgentRuntimeContextAssertionError,
    AgentRuntimeContextVerifier,
    HmacAgentRuntimeContextVerifier,
)
from agent_runtime.refund.answer import RefundAnswerComposer
from agent_runtime.refund.graph import build_refund_graph
from agent_runtime.refund.intent import RefundIntentExtractor
from agent_runtime.refund.proposal import RefundProposalBuilder
from agent_runtime.refund.schemas import (
    RefundIntakeRequest,
    RefundIntakeResponse,
)

router = APIRouter(prefix="/refunds", tags=["refunds"])
configured_intent_extractor = ConfiguredRefundIntentExtractor()
configured_answer_composer = ConfiguredRefundAnswerComposer()


def get_refund_intent_extractor() -> RefundIntentExtractor:
    return configured_intent_extractor


def get_refund_answer_composer() -> RefundAnswerComposer:
    return configured_answer_composer


def get_refund_proposal_builder() -> RefundProposalBuilder:
    return RefundProposalBuilder(
        versions=RefundProposalSettings().to_versions(),
    )


def get_agent_runtime_context_verifier() -> AgentRuntimeContextVerifier:
    settings = AgentRuntimeContextSettings()

    return HmacAgentRuntimeContextVerifier(
        secret=settings.context_assertion_hmac_secret.get_secret_value(),
        expected_issuer=settings.context_assertion_issuer,
        expected_audience=(
            settings.agent_runtime_context_assertion_audience
        ),
        expected_tenant_id=settings.tenant_id,
        expected_environment_id=settings.environment_id,
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
    answer_composer: Annotated[
        RefundAnswerComposer,
        Depends(get_refund_answer_composer),
    ],
    context_verifier: Annotated[
        AgentRuntimeContextVerifier,
        Depends(get_agent_runtime_context_verifier),
    ],
    agent_runtime_context_assertion: Annotated[
        str | None,
        Header(alias=AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER),
    ] = None,
    context_assertion: Annotated[
        str | None,
        Header(alias=CONTEXT_ASSERTION_HEADER),
    ] = None,
    knowledge_rag_context_assertion: Annotated[
        str | None,
        Header(alias=KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER),
    ] = None,
) -> RefundIntakeResponse:
    if (
        not context_assertion
        or len(context_assertion) > 8_192
        or not knowledge_rag_context_assertion
        or len(knowledge_rag_context_assertion) > 8_192
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            },
        )

    try:
        trusted_context = context_verifier.verify(
            agent_runtime_context_assertion
        )
    except AgentRuntimeContextAssertionError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            },
        ) from error

    knowledge_rag_settings = KnowledgeRagClientSettings()
    graph = build_refund_graph(
        McpOrderLookupClient(context_assertion=context_assertion),
        intent_extractor,
        proposal_builder,
        KnowledgeRagCustomerEvidenceClient(
            context_assertion=knowledge_rag_context_assertion,
            base_url=knowledge_rag_settings.knowledge_rag_base_url,
            timeout_seconds=knowledge_rag_settings.knowledge_rag_timeout_seconds,
        ),
        answer_composer,
    )

    try:
        result = await graph.ainvoke(
            {
                **request.model_dump(),
                "tenant_id": trusted_context.tenant_id,
                "environment_id": trusted_context.environment_id,
                "context_id": trusted_context.context_id,
                "request_id": trusted_context.request_id,
                "turn_id": str(uuid4()),
                "trace_id": trusted_context.trace_id,
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
    except CustomerEvidenceLookupUnauthorizedError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            },
        ) from error

    return RefundIntakeResponse.model_validate(result)
