from __future__ import annotations

from typing import Protocol

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER = "x-cso-knowledge-context-assertion"


class CustomerEvidenceLookupError(RuntimeError):
    """Raised when customer-safe knowledge evidence cannot be retrieved."""


class CustomerEvidenceLookupUnavailableError(CustomerEvidenceLookupError):
    def __init__(self) -> None:
        super().__init__("Customer evidence retrieval is unavailable")


class CustomerEvidenceLookupUnauthorizedError(CustomerEvidenceLookupError):
    def __init__(self) -> None:
        super().__init__("Trusted context is required")


class CustomerEvidenceCitation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_uri: str = Field(min_length=1)
    title: str = Field(min_length=1)
    section_path: list[str] = Field(min_length=1)
    page_start: int | None = Field(default=None, gt=0)
    page_end: int | None = Field(default=None, gt=0)


class CustomerEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    citation: CustomerEvidenceCitation
    retrieval_methods: list[str] = Field(min_length=1)
    reranker_rank: int = Field(gt=0)


class CustomerEvidenceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledge_release_id: str = Field(min_length=1)
    evidence: list[CustomerEvidence]


class CustomerEvidenceLookup(Protocol):
    async def retrieve_customer_evidence(
        self,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        """Retrieve only customer-safe evidence for the current request."""


class KnowledgeRagCustomerEvidenceClient:
    def __init__(
        self,
        *,
        context_assertion: str,
        base_url: str = "http://127.0.0.1:8001",
        timeout_seconds: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        assertion = context_assertion.strip()

        if not assertion or len(assertion) > 8_192:
            raise ValueError("knowledge_rag_context_assertion is invalid")

        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")

        self._context_assertion = assertion
        self._endpoint = str(
            httpx.URL(base_url).join("/v1/customer-evidence")
        )
        self._timeout_seconds = timeout_seconds
        self._transport = transport

    async def retrieve_customer_evidence(
        self,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        normalized_query = query_text.strip()

        if not normalized_query:
            raise ValueError("query_text is required")

        try:
            async with httpx.AsyncClient(
                timeout=self._timeout_seconds,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    self._endpoint,
                    headers={
                        KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER: (
                            self._context_assertion
                        ),
                    },
                    json={"query_text": normalized_query},
                )
        except httpx.HTTPError as error:
            raise CustomerEvidenceLookupUnavailableError() from error

        if response.status_code == 401:
            raise CustomerEvidenceLookupUnauthorizedError()

        if response.status_code < 200 or response.status_code >= 300:
            raise CustomerEvidenceLookupUnavailableError()

        try:
            return CustomerEvidenceResponse.model_validate(response.json())
        except (ValidationError, ValueError) as error:
            raise CustomerEvidenceLookupUnavailableError() from error
