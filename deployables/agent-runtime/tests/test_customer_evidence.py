import json

import httpx
import pytest

from agent_runtime.integrations.customer_evidence import (
    KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
    CustomerEvidenceLookupUnauthorizedError,
    KnowledgeRagCustomerEvidenceClient,
)


@pytest.mark.asyncio
async def test_client_forwards_the_rag_context_and_validates_evidence() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url == "http://knowledge-rag:8001/v1/customer-evidence"
        assert request.headers[KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER] == (
            "knowledge-rag-context"
        )
        assert json.loads(request.content) == {
            "query_text": "Can I get a refund?"
        }

        return httpx.Response(
            200,
            json={
                "knowledge_release_id": "refund-policy-2026-08-01",
                "evidence": [
                    {
                        "knowledge_document_id": "refund-policy-current-2026-08-01",
                        "chunk_id": "section-003-chunk-001",
                        "content": "Damaged items may be refunded.",
                        "citation": {
                            "source_uri": "s3://cso-knowledge/tenant-local/refund-policy-2026-08-01.md",
                            "title": "Refund Policy",
                            "section_path": ["Refund eligibility"],
                            "page_start": None,
                            "page_end": None,
                        },
                        "retrieval_methods": ["semantic_vector"],
                        "reranker_rank": 1,
                    }
                ],
            },
        )

    client = KnowledgeRagCustomerEvidenceClient(
        context_assertion="knowledge-rag-context",
        base_url="http://knowledge-rag:8001",
        transport=httpx.MockTransport(handler),
    )

    response = await client.retrieve_customer_evidence(
        "  Can I get a refund?  "
    )

    assert response.knowledge_release_id == "refund-policy-2026-08-01"
    assert response.evidence[0].chunk_id == "section-003-chunk-001"


@pytest.mark.asyncio
async def test_client_maps_rag_context_rejection_to_a_stable_error() -> None:
    client = KnowledgeRagCustomerEvidenceClient(
        context_assertion="knowledge-rag-context",
        transport=httpx.MockTransport(lambda _: httpx.Response(401)),
    )

    with pytest.raises(CustomerEvidenceLookupUnauthorizedError):
        await client.retrieve_customer_evidence("Can I get a refund?")


def test_client_rejects_a_missing_rag_context_assertion() -> None:
    with pytest.raises(ValueError, match="knowledge_rag_context_assertion"):
        KnowledgeRagCustomerEvidenceClient(context_assertion=" ")
