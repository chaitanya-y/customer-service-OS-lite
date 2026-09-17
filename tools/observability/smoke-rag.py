"""Real RAG HTTP path with synthetic auth and deterministic external boundaries."""

import os
import socket

import uvicorn
from knowledge_rag.api import get_context_verifier, get_customer_evidence_retriever
from knowledge_rag.config import KnowledgeRetrievalSettings
from knowledge_rag.customer_evidence import ConfiguredCustomerEvidenceRetriever
from knowledge_rag.embeddings import DeterministicEmbeddingProvider
from knowledge_rag.main import app
from knowledge_rag.observability import telemetry_runtime
from knowledge_rag.reranking import DeterministicRerankingProvider
from knowledge_rag.retrieval_service import KnowledgeRetrievalService
from knowledge_rag.trusted_context import HmacKnowledgeRagContextVerifier


class SyntheticSearch:
    def search(self, *, index, body):
        return {"hits": {"hits": []}}


embedding = DeterministicEmbeddingProvider(dimension=8)
settings = KnowledgeRetrievalSettings(
    _env_file=None,
    openai_api_key="synthetic-unused",
    tenant_id="smoke-tenant",
    environment_id="local",
    context_assertion_hmac_secret=os.environ["CONTEXT_ASSERTION_HMAC_SECRET"],
    context_assertion_issuer="smoke-edge",
    knowledge_release_id="smoke-release",
    knowledge_index_name="smoke-index",
)
retriever = ConfiguredCustomerEvidenceRetriever(
    settings=settings,
    embedding_model=embedding.model,
    retrieval_service=KnowledgeRetrievalService(
        client=SyntheticSearch(),
        index_name="smoke-index",
        embedding_provider=embedding,
        reranking_provider=DeterministicRerankingProvider(),
        telemetry_runtime=telemetry_runtime,
    ),
)
verifier = HmacKnowledgeRagContextVerifier(
    secret=os.environ["CONTEXT_ASSERTION_HMAC_SECRET"],
    expected_issuer="smoke-edge",
    expected_audience="knowledge-rag",
    expected_tenant_id="smoke-tenant",
    expected_environment_id="local",
)
app.dependency_overrides[get_context_verifier] = lambda: verifier
app.dependency_overrides[get_customer_evidence_retriever] = lambda: retriever

if __name__ == "__main__":
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        print(listener.getsockname()[1], flush=True)
        uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False)).run(
            sockets=[listener]
        )
