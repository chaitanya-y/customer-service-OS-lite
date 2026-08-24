from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from typing import Protocol

from openai import OpenAI
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .chunking import ChunkDraft


class EmbeddingProviderContractError(ValueError):
    """Raised when an embedding provider violates its interface contract."""


class EmbeddingModel(BaseModel):
    model_config = ConfigDict(frozen=True)

    provider: str = Field(min_length=1)
    model_name: str = Field(min_length=1)
    model_version: str = Field(min_length=1)
    dimension: int = Field(gt=0)


class EmbeddedChunk(BaseModel):
    model_config = ConfigDict(frozen=True)

    chunk_id: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    vector: list[float] = Field(min_length=1)
    embedding_model: EmbeddingModel

    @model_validator(mode="after")
    def validate_vector(self) -> EmbeddedChunk:
        if len(self.vector) != self.embedding_model.dimension:
            raise ValueError("Vector length must match embedding model dimension")

        if not all(math.isfinite(value) for value in self.vector):
            raise ValueError("Embedding vector values must be finite")

        return self


class EmbeddingProvider(Protocol):
    model: EmbeddingModel

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        """Return one vector for every supplied text, in the same order."""


class DeterministicEmbeddingProvider:
    """
    Test-only provider.

    It creates repeatable vectors from SHA-256. These vectors have no semantic
    meaning and must never be used for a real retrieval index.
    """

    def __init__(self, dimension: int = 16) -> None:
        self.model = EmbeddingModel(
            provider="deterministic",
            model_name="sha256-test-embedding",
            model_version="v1",
            dimension=dimension,
        )

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_text(text) for text in texts]

    def _embed_text(self, text: str) -> list[float]:
        if not text.strip():
            raise ValueError("Cannot embed empty text")

        digest = hashlib.sha256(
            f"{self.model.model_version}\0{text}".encode()
        ).digest()

        raw_vector = [
            (digest[index % len(digest)] - 127.5) / 127.5
            for index in range(self.model.dimension)
        ]
        vector_norm = math.sqrt(sum(value * value for value in raw_vector))

        return [value / vector_norm for value in raw_vector]

class OpenAIEmbeddingProvider:
    """
    Real embedding provider for local development and deployment.

    API keys are injected by the application environment; they are never
    recorded in an ingestion artifact or committed to Git.
    """

    def __init__(
        self,
        *,
        api_key: str,
        model_name: str = "text-embedding-3-small",
        dimension: int = 1536,
    ) -> None:
        self._client = OpenAI(api_key=api_key)
        self.model = EmbeddingModel(
            provider="openai",
            model_name=model_name,
            model_version="openai-embeddings-v1",
            dimension=dimension,
        )

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []

        if any(not text.strip() for text in texts):
            raise ValueError("Cannot embed empty text")

        response = self._client.embeddings.create(
            model=self.model.model_name,
            input=list(texts),
            dimensions=self.model.dimension,
            encoding_format="float",
        )
        response_items = sorted(response.data, key=lambda item: item.index)
        vectors = [list(item.embedding) for item in response_items]

        if len(vectors) != len(texts):
            raise EmbeddingProviderContractError(
                "OpenAI returned a different number of vectors than inputs."
            )

        return vectors


def embed_chunks(
    chunks: Sequence[ChunkDraft],
    provider: EmbeddingProvider,
) -> list[EmbeddedChunk]:
    vectors = provider.embed_documents([chunk.content for chunk in chunks])

    if len(vectors) != len(chunks):
        raise EmbeddingProviderContractError(
            "Embedding provider must return one vector for every input chunk."
        )

    return [
        EmbeddedChunk(
            chunk_id=chunk.chunk_id,
            content_sha256=chunk.content_sha256,
            vector=vector,
            embedding_model=provider.model,
        )
        for chunk, vector in zip(chunks, vectors, strict=True)
    ]