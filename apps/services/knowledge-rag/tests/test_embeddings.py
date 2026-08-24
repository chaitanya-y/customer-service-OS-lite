import pytest

from knowledge_rag.chunking import ChunkDraft
from knowledge_rag.embeddings import (
    DeterministicEmbeddingProvider,
    EmbeddingModel,
    EmbeddingProviderContractError,
    embed_chunks,
)


def make_chunk(
    *,
    chunk_id: str = "section-001-chunk-001",
    content: str = "Refunds are available within thirty days.",
) -> ChunkDraft:
    return ChunkDraft(
        chunk_id=chunk_id,
        parent_section_id="section-001",
        chunk_ordinal_within_section=1,
        source_uri="s3://cso-knowledge/acme/refund-policy.md",
        source_content_sha256="a" * 64,
        title="ACME Refund Policy",
        section_path=["Refund policy", "Refund eligibility"],
        content=content,
        content_sha256="b" * 64,
        token_count=8,
        chunking_strategy_version="structure-aware-parent-child-v1",
    )


def test_deterministic_provider_returns_same_vector_for_same_text() -> None:
    provider = DeterministicEmbeddingProvider(dimension=8)

    first_vector = provider.embed_documents(["Same policy text."])[0]
    second_vector = provider.embed_documents(["Same policy text."])[0]

    assert first_vector == second_vector
    assert len(first_vector) == 8


def test_embed_chunks_preserves_chunk_identity_and_content_hash() -> None:
    chunk = make_chunk()
    provider = DeterministicEmbeddingProvider(dimension=8)

    embedded_chunks = embed_chunks([chunk], provider)

    assert len(embedded_chunks) == 1
    assert embedded_chunks[0].chunk_id == chunk.chunk_id
    assert embedded_chunks[0].content_sha256 == chunk.content_sha256
    assert embedded_chunks[0].embedding_model == provider.model
    assert len(embedded_chunks[0].vector) == 8


def test_deterministic_provider_changes_vector_when_content_changes() -> None:
    provider = DeterministicEmbeddingProvider(dimension=8)

    first_vector = provider.embed_documents(["Refund eligible."])[0]
    second_vector = provider.embed_documents(["Refund denied."])[0]

    assert first_vector != second_vector


def test_embed_chunks_rejects_provider_with_wrong_vector_count() -> None:
    class WrongCountProvider:
        model = EmbeddingModel(
            provider="test",
            model_name="wrong-count",
            model_version="v1",
            dimension=2,
        )

        def embed_documents(self, texts: list[str]) -> list[list[float]]:
            return []

    with pytest.raises(
        EmbeddingProviderContractError,
        match="one vector for every input chunk",
    ):
        embed_chunks([make_chunk()], WrongCountProvider())