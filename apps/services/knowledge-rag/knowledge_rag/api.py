from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from .config import KnowledgeRetrievalSettings
from .customer_evidence import (
    CustomerEvidenceRetriever,
    create_configured_customer_evidence_retriever,
)
from .retrieval_service import RetrievalServiceError
from .trusted_context import (
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
    HmacKnowledgeRagContextVerifier,
    KnowledgeRagContextAssertionError,
    KnowledgeRagContextVerifier,
)

router = APIRouter(prefix="/v1", tags=["knowledge"])


class CustomerEvidenceRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    query_text: str = Field(min_length=1, max_length=2_000)


class CustomerEvidenceCitation(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_uri: str = Field(min_length=1)
    title: str = Field(min_length=1)
    section_path: list[str] = Field(min_length=1)
    page_start: int | None = None
    page_end: int | None = None


class CustomerEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    citation: CustomerEvidenceCitation
    retrieval_methods: list[str] = Field(min_length=1)
    reranker_rank: int = Field(gt=0)


class CustomerEvidenceResponse(BaseModel):
    model_config = ConfigDict(frozen=True)

    knowledge_release_id: str = Field(min_length=1)
    evidence: list[CustomerEvidence]


@lru_cache
def get_context_verifier() -> KnowledgeRagContextVerifier:
    settings = KnowledgeRetrievalSettings()

    return HmacKnowledgeRagContextVerifier(
        secret=settings.context_assertion_hmac_secret.get_secret_value(),
        expected_issuer=settings.context_assertion_issuer,
        expected_audience=(
            settings.knowledge_rag_context_assertion_audience
        ),
        expected_tenant_id=settings.tenant_id,
        expected_environment_id=settings.environment_id,
    )


@lru_cache
def get_customer_evidence_retriever() -> CustomerEvidenceRetriever:
    return create_configured_customer_evidence_retriever(
        KnowledgeRetrievalSettings()
    )


@router.post("/customer-evidence", response_model=CustomerEvidenceResponse)
def retrieve_customer_evidence(
    request: CustomerEvidenceRequest,
    context_verifier: Annotated[
        KnowledgeRagContextVerifier,
        Depends(get_context_verifier),
    ],
    evidence_retriever: Annotated[
        CustomerEvidenceRetriever,
        Depends(get_customer_evidence_retriever),
    ],
    context_assertion: Annotated[
        str | None,
        Header(alias=KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER),
    ] = None,
) -> CustomerEvidenceResponse:
    try:
        trusted_context = context_verifier.verify(context_assertion)
    except KnowledgeRagContextAssertionError as error:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "code": "context_unauthorized",
                "message": "Trusted context is required",
            },
        ) from error

    try:
        result = evidence_retriever.retrieve(
            query_text=request.query_text,
            context=trusted_context,
        )
    except RetrievalServiceError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "code": "knowledge_retrieval_unavailable",
                "message": "Knowledge retrieval is unavailable",
            },
        ) from error

    return CustomerEvidenceResponse(
        knowledge_release_id=result.request.knowledge_release_id,
        evidence=[
            CustomerEvidence(
                knowledge_document_id=(
                    ranked.fused_evidence.evidence.knowledge_document_id
                ),
                chunk_id=ranked.fused_evidence.evidence.chunk_id,
                content=ranked.fused_evidence.evidence.content,
                citation=CustomerEvidenceCitation(
                    source_uri=ranked.fused_evidence.evidence.citation.source_uri,
                    title=ranked.fused_evidence.evidence.citation.title,
                    section_path=(
                        ranked.fused_evidence.evidence.citation.section_path
                    ),
                    page_start=(
                        ranked.fused_evidence.evidence.citation.page_start
                    ),
                    page_end=(
                        ranked.fused_evidence.evidence.citation.page_end
                    ),
                ),
                retrieval_methods=(
                    ranked.fused_evidence.contributing_retrievers
                ),
                reranker_rank=ranked.reranker_rank,
            )
            for ranked in result.evidence
        ],
    )
