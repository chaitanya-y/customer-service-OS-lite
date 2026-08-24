import hashlib
from pathlib import Path

import pytest

from knowledge_rag.embeddings import (
    DeterministicEmbeddingProvider,
    embed_chunks,
)
from knowledge_rag.index_documents import (
    IndexPreparationError,
    build_index_documents,
)
from knowledge_rag.ingestion import (
    IngestionRequest,
    KnowledgeDocumentClassification,
    process_ingestion,
)
from knowledge_rag.models import SourceContentType

SOURCE_PATH = (
    Path(__file__).parents[2]
    / "control-knowledge"
    / "fixtures"
    / "source-documents"
    / "acme"
    / "refund-policy-2026-08-01.md"
)


def make_artifact():
    request = IngestionRequest(
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
    return process_ingestion(request)


def make_embedded_chunks():
    artifact = make_artifact()
    provider = DeterministicEmbeddingProvider(dimension=8)

    return artifact, embed_chunks(artifact.chunks, provider)


def test_build_index_documents_preserves_governed_metadata() -> None:
    artifact, embedded_chunks = make_embedded_chunks()

    index_documents = build_index_documents(artifact, embedded_chunks)

    assert len(index_documents) == len(artifact.chunks)

    first_document = index_documents[0]
    first_chunk = artifact.chunks[0]
    first_embedded_chunk = embedded_chunks[0]

    assert first_document.chunk_id == first_chunk.chunk_id
    assert first_document.content == first_chunk.content
    assert first_document.content_sha256 == first_chunk.content_sha256
    assert first_document.embedding_vector == first_embedded_chunk.vector
    assert first_document.knowledge_release_id == artifact.knowledge_release_id
    assert first_document.tenant_id == "acme"
    assert first_document.classification == "CUSTOMER_SAFE"
    assert first_document.artifact_sha256 == artifact.artifact_sha256


def test_build_index_documents_rejects_missing_embeddings() -> None:
    artifact, embedded_chunks = make_embedded_chunks()

    with pytest.raises(
        IndexPreparationError,
        match="must contain exactly the artifact chunk IDs",
    ):
        build_index_documents(artifact, embedded_chunks[:-1])


def test_build_index_documents_rejects_wrong_content_hash() -> None:
    artifact, embedded_chunks = make_embedded_chunks()
    wrong_hash_chunk = embedded_chunks[0].model_copy(
        update={"content_sha256": "0" * 64}
    )

    with pytest.raises(
        IndexPreparationError,
        match="Embedding content hash does not match",
    ):
        build_index_documents(
            artifact,
            [wrong_hash_chunk, *embedded_chunks[1:]],
        )


def test_build_index_documents_creates_stable_ids() -> None:
    artifact, embedded_chunks = make_embedded_chunks()

    first_documents = build_index_documents(artifact, embedded_chunks)
    second_documents = build_index_documents(artifact, embedded_chunks)

    assert [
        document.index_document_id for document in first_documents
    ] == [
        document.index_document_id for document in second_documents
    ]