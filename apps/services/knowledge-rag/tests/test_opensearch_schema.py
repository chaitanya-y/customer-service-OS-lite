import hashlib
from pathlib import Path

import pytest

from knowledge_rag.embeddings import (
    DeterministicEmbeddingProvider,
    embed_chunks,
)
from knowledge_rag.index_documents import build_index_documents
from knowledge_rag.ingestion import (
    IngestionRequest,
    KnowledgeDocumentClassification,
    process_ingestion,
)
from knowledge_rag.models import SourceContentType
from knowledge_rag.opensearch_schema import (
    OpenSearchIndexConfig,
    OpenSearchSchemaError,
    build_bulk_index_payload,
    build_index_definition,
)

SOURCE_PATH = (
    Path(__file__).parents[2]
    / "control-knowledge"
    / "fixtures"
    / "source-documents"
    / "acme"
    / "refund-policy-2026-08-01.md"
)


def make_index_documents():
    artifact = process_ingestion(
        IngestionRequest(
            ingestion_job_id="ingestion-001",
            idempotency_key="acme-refund-policy-2026-08-01",
            knowledge_release_id="refund-policy-2026-08-01",
            tenant_id="acme",
            environment_id="local",
            knowledge_document_id="knowledge-document-001",
            source_document_id="refund-policy",
            source_version="2026-08-01",
            classification=KnowledgeDocumentClassification.CUSTOMER_SAFE,
            locale="en-US",
            source_path=SOURCE_PATH,
            source_uri=(
                "s3://cso-knowledge/acme/refund-policy-2026-08-01.md"
            ),
            expected_source_content_type=SourceContentType.MARKDOWN,
            expected_source_content_sha256=hashlib.sha256(
                SOURCE_PATH.read_bytes()
            ).hexdigest(),
        )
    )
    embedded_chunks = embed_chunks(
        artifact.chunks,
        DeterministicEmbeddingProvider(dimension=8),
    )

    return build_index_documents(artifact, embedded_chunks)


def make_config(*, vector_dimension: int = 8) -> OpenSearchIndexConfig:
    return OpenSearchIndexConfig(
        index_name="cso-knowledge-acme-local-v1",
        vector_dimension=vector_dimension,
        number_of_replicas=0,
    )


def test_build_index_definition_defines_governed_vector_index() -> None:
    definition = build_index_definition(make_config())

    assert definition["settings"]["index"]["knn"] is True
    assert definition["mappings"]["dynamic"] == "strict"
    assert (
        definition["mappings"]["properties"]["embedding_vector"]["type"]
        == "knn_vector"
    )
    assert (
        definition["mappings"]["properties"]["embedding_vector"]["dimension"]
        == 8
    )
    assert (
        definition["mappings"]["properties"]["tenant_id"]["type"]
        == "keyword"
    )


def test_build_bulk_index_payload_creates_action_document_pairs() -> None:
    index_documents = make_index_documents()
    payload = build_bulk_index_payload(make_config(), index_documents)

    assert len(payload) == len(index_documents) * 2

    first_action = payload[0]
    first_document = payload[1]

    assert first_action["index"]["_index"] == "cso-knowledge-acme-local-v1"
    assert first_action["index"]["_id"] == first_document["index_document_id"]
    assert first_document["tenant_id"] == "acme"
    assert len(first_document["embedding_vector"]) == 8


def test_build_bulk_index_payload_rejects_wrong_vector_dimension() -> None:
    with pytest.raises(
        OpenSearchSchemaError,
        match="dimension does not match index vector dimension",
    ):
        build_bulk_index_payload(make_config(vector_dimension=7), make_index_documents())


def test_build_bulk_index_payload_rejects_mixed_embedding_models() -> None:
    index_documents = make_index_documents()
    second_document = index_documents[1].model_copy(
        update={
            "embedding_model": index_documents[1].embedding_model.model_copy(
                update={"model_name": "different-embedding-model"}
            )
        }
    )

    with pytest.raises(
        OpenSearchSchemaError,
        match="cannot mix embedding models",
    ):
        build_bulk_index_payload(
            make_config(),
            [index_documents[0], second_document, *index_documents[2:]],
        )