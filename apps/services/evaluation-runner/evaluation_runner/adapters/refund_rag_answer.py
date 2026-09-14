from __future__ import annotations

import asyncio
import hashlib
from typing import Literal, Protocol

from agent_runtime.integrations.customer_evidence import (
    CustomerEvidence,
    CustomerEvidenceCitation,
)
from agent_runtime.integrations.order_lookup import (
    CustomerRef,
    Money,
    OrderContext,
    OrderItem,
    OrderSource,
)
from agent_runtime.refund.answer import (
    REFUND_ANSWER_PROMPT_VERSION,
    RefundAnswerComposer,
    RefundAnswerCompositionError,
    RefundAnswerRejectionCode,
)
from agent_runtime.refund.intent import RefundIntentExtraction, RefundReasonCode
from agent_runtime.refund.proposal import RefundProposalBuilder
from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.evaluation import EvidenceReference
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.opensearch_retrieval import RetrievalRequest
from knowledge_rag.retrieval_service import RetrievalExecutionResult
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .knowledge_answer import (
    KnowledgeAnswerEvidence,
    KnowledgeAnswerExecutionResult,
    KnowledgeAnswerRequest,
)


class RejectedAnswerEvidence(BaseModel):
    """Content-free identity for evidence supplied to a rejected answer."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    rank: int = Field(gt=0)
    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    classification: Literal["CUSTOMER_SAFE"]


class RefundAnswerRejectionDiagnostic(BaseModel):
    """Bounded rejected model answer evidence for synthetic diagnosis only."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    stage: Literal["ANSWER_COMPOSITION_POST_MODEL_VALIDATION"]
    rejection_code: RefundAnswerRejectionCode
    response: str = Field(min_length=1, max_length=2_000)
    response_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    citations: list[EvidenceReference] = Field(max_length=10)
    evidence: list[RejectedAnswerEvidence] = Field(min_length=1)
    versions: dict[str, str] = Field(min_length=1)


class RefundRagAnswerExecutorError(RuntimeError):
    """Raised when the isolated production RAG answer boundary cannot be evaluated."""

    def __init__(
        self,
        message: str,
        *,
        rejection_diagnostic: RefundAnswerRejectionDiagnostic | None = None,
    ) -> None:
        self.rejection_diagnostic = rejection_diagnostic
        super().__init__(message)


class RefundAnswerSystemContext(BaseModel):
    """Synthetic trusted facts needed by the production refund answer composer."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    order_reference: str = Field(min_length=1, max_length=100)
    item_name: str = Field(min_length=1, max_length=300)
    reason_code: RefundReasonCode
    scope: Literal["FULL_ORDER"]
    requested_amount_minor: int = Field(gt=0)


class KnowledgeRetrievalExecutor(Protocol):
    def retrieve(self, request: RetrievalRequest) -> RetrievalExecutionResult:
        """Run the production governed retrieval pipeline."""


class RefundRagAnswerExecutor:
    """Evaluate exact production retrieval and answer components without commerce."""

    def __init__(
        self,
        *,
        retrieval_executor: KnowledgeRetrievalExecutor,
        embedding_model: EmbeddingModel,
        answer_composer: RefundAnswerComposer,
        proposal_builder: RefundProposalBuilder,
        answer_model: str,
        top_k: int = 3,
    ) -> None:
        if not answer_model.strip():
            raise ValueError("answer_model must be non-empty")
        if top_k <= 0:
            raise ValueError("top_k must be positive")

        self._retrieval_executor = retrieval_executor
        self._embedding_model = embedding_model
        self._answer_composer = answer_composer
        self._proposal_builder = proposal_builder
        self._answer_model = answer_model
        self._top_k = top_k

    async def execute(
        self,
        request: KnowledgeAnswerRequest,
        *,
        repetition: int,
    ) -> KnowledgeAnswerExecutionResult:
        try:
            system_context = RefundAnswerSystemContext.model_validate(
                request.system_context
            )
        except ValidationError as error:
            raise RefundRagAnswerExecutorError(
                "Invalid synthetic refund answer system context."
            ) from error

        # Snapshot independent facts before any answer/proposal component runs.
        application_facts = _build_application_facts(system_context)
        order_context = _build_synthetic_order_context(
            request=request,
            context=system_context,
        )
        proposal = self._proposal_builder.build(
            extraction=RefundIntentExtraction(
                reason_code=system_context.reason_code,
                scope=system_context.scope,
                selected_item_ids=[],
            ),
            order_context=order_context,
            turn_id=f"{request.case_id}-trial-{repetition}",
            trace_id=f"{request.case_id}-trace-{repetition}",
        )
        retrieval_request = RetrievalRequest(
            query_text=request.user_input,
            tenant_id=request.tenant_id,
            environment_id=request.environment_id,
            knowledge_release_id=request.knowledge_release_id,
            allowed_classifications=request.allowed_classifications,
            locale=request.locale,
            as_of=request.as_of,
            embedding_model=self._embedding_model,
            top_k=self._top_k,
        )
        retrieval_result = await asyncio.to_thread(
            self._retrieval_executor.retrieve,
            retrieval_request,
        )
        if retrieval_result.request != retrieval_request:
            raise RefundRagAnswerExecutorError(
                "Retrieval result does not match the evaluated request."
            )
        if not retrieval_result.evidence:
            raise RefundRagAnswerExecutorError(
                "RAGAS answer evaluation requires retrieved evidence."
            )
        _validate_retrieval_evidence_context(
            request=request,
            result=retrieval_result,
        )

        customer_evidence = [
            _to_customer_evidence(ranked) for ranked in retrieval_result.evidence
        ]
        versions = _build_versions(
            request=request,
            result=retrieval_result,
            answer_model=self._answer_model,
        )
        try:
            answer = await self._answer_composer.compose(
                customer_message=request.user_input,
                refund_proposal=proposal,
                order_context=order_context,
                knowledge_evidence=customer_evidence,
            )
        except RefundAnswerCompositionError as error:
            raise RefundRagAnswerExecutorError(
                f"Customer answer rejected: {error.reason_code.value}.",
                rejection_diagnostic=_build_rejection_diagnostic(
                    error=error,
                    result=retrieval_result,
                    versions=versions,
                ),
            ) from error

        return KnowledgeAnswerExecutionResult(
            response=answer.message,
            application_facts=application_facts,
            evidence=[
                _to_evaluation_evidence(ranked) for ranked in retrieval_result.evidence
            ],
            citations=[
                EvidenceReference(
                    knowledge_document_id=citation.knowledge_document_id,
                    chunk_id=citation.chunk_id,
                )
                for citation in answer.citations
            ],
            versions=versions,
        )


def _validate_retrieval_evidence_context(
    *,
    request: KnowledgeAnswerRequest,
    result: RetrievalExecutionResult,
) -> None:
    for ranked in result.evidence:
        evidence = ranked.fused_evidence.evidence
        if (
            evidence.classification != "CUSTOMER_SAFE"
            or evidence.tenant_id != request.tenant_id
            or evidence.environment_id != request.environment_id
            or evidence.knowledge_release_id != request.knowledge_release_id
            or evidence.locale != request.locale
        ):
            raise RefundRagAnswerExecutorError(
                "Retrieved evidence is outside the trusted answer context."
            )


def _build_rejection_diagnostic(
    *,
    error: RefundAnswerCompositionError,
    result: RetrievalExecutionResult,
    versions: dict[str, str],
) -> RefundAnswerRejectionDiagnostic | None:
    answer = error.rejected_answer
    if answer is None:
        return None
    return RefundAnswerRejectionDiagnostic(
        stage="ANSWER_COMPOSITION_POST_MODEL_VALIDATION",
        rejection_code=error.reason_code,
        response=answer.message,
        response_sha256=hashlib.sha256(answer.message.encode()).hexdigest(),
        citations=[
            EvidenceReference(
                knowledge_document_id=citation.knowledge_document_id,
                chunk_id=citation.chunk_id,
            )
            for citation in answer.citations
        ],
        evidence=[
            RejectedAnswerEvidence(
                rank=rank,
                knowledge_document_id=ranked.fused_evidence.evidence.knowledge_document_id,
                chunk_id=ranked.fused_evidence.evidence.chunk_id,
                content_sha256=ranked.fused_evidence.evidence.content_sha256,
                classification="CUSTOMER_SAFE",
            )
            for rank, ranked in enumerate(result.evidence, start=1)
        ],
        versions=versions,
    )


def _build_versions(
    *,
    request: KnowledgeAnswerRequest,
    result: RetrievalExecutionResult,
    answer_model: str,
) -> dict[str, str]:
    return {
        "application_facts": "synthetic-refund-facts-v1",
        "answer_model": answer_model,
        "answer_prompt": REFUND_ANSWER_PROMPT_VERSION,
        "embedding_model": _embedding_model_version(result.embedding_model),
        "knowledge_release": request.knowledge_release_id,
        "reranker_model": _reranker_model_version(result),
    }


def _build_application_facts(context: RefundAnswerSystemContext) -> list[str]:
    """Describe fixture truth, not a model verdict or a live workflow outcome."""
    dollars, cents = divmod(context.requested_amount_minor, 100)
    return [
        f"Order reference: {context.order_reference}.",
        f"Item name: {context.item_name}.",
        f"Customer-reported refund reason: {context.reason_code}.",
        "Requested refund scope: the full order.",
        f"Proposed refund amount: USD {dollars:,}.{cents:02d}.",
        "No refund has been approved or executed in this evaluation.",
        "Customer delivery timing has not been verified.",
    ]


def _build_synthetic_order_context(
    *,
    request: KnowledgeAnswerRequest,
    context: RefundAnswerSystemContext,
) -> OrderContext:
    item_id = "evaluation-item-001"
    amount = Money(
        amount_minor=context.requested_amount_minor,
        currency="USD",
    )
    facts_digest = hashlib.sha256(
        (
            f"{request.case_id}\0{context.order_reference}\0"
            f"{context.item_name}\0{context.requested_amount_minor}"
        ).encode()
    ).hexdigest()
    return OrderContext(
        schema_version="1",
        observation_id=f"{request.case_id}-order-observation",
        observed_at=request.as_of,
        source=OrderSource(
            provider="evaluation-fixture",
            order_id=f"{request.case_id}-order",
            facts_version=f"sha256:{facts_digest}",
        ),
        reference=context.order_reference,
        status="DELIVERED",
        active=False,
        placed_at=request.as_of,
        customer_ref=CustomerRef(customer_id="evaluation-customer"),
        total=amount,
        items=[
            OrderItem(
                item_id=item_id,
                sku="EVALUATION-SKU",
                name=context.item_name,
                quantity=1,
                unit_price=amount,
                line_total=amount,
            )
        ],
        payments=[],
        fulfillments=[],
    )


def _to_customer_evidence(ranked) -> CustomerEvidence:
    evidence = ranked.fused_evidence.evidence
    return CustomerEvidence(
        knowledge_document_id=evidence.knowledge_document_id,
        chunk_id=evidence.chunk_id,
        content=evidence.content,
        citation=CustomerEvidenceCitation(
            source_uri=evidence.citation.source_uri,
            title=evidence.citation.title,
            section_path=evidence.citation.section_path,
            page_start=evidence.citation.page_start,
            page_end=evidence.citation.page_end,
        ),
        retrieval_methods=ranked.fused_evidence.contributing_retrievers,
        reranker_rank=ranked.reranker_rank,
    )


def _to_evaluation_evidence(ranked) -> KnowledgeAnswerEvidence:
    evidence = ranked.fused_evidence.evidence
    return KnowledgeAnswerEvidence(
        knowledge_document_id=evidence.knowledge_document_id,
        chunk_id=evidence.chunk_id,
        content=evidence.content,
        content_sha256=evidence.content_sha256,
        tenant_id=evidence.tenant_id,
        environment_id=evidence.environment_id,
        knowledge_release_id=evidence.knowledge_release_id,
        classification=KnowledgeDocumentClassification(evidence.classification),
        locale=evidence.locale,
    )


def _embedding_model_version(model: EmbeddingModel) -> str:
    return (
        f"{model.provider}:{model.model_name}:{model.model_version}:{model.dimension}"
    )


def _reranker_model_version(result: RetrievalExecutionResult) -> str:
    model = result.reranker_model
    return f"{model.provider}:{model.model_name}:{model.model_version}"
