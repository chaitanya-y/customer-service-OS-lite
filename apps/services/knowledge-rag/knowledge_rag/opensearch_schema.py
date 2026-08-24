from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from .index_documents import IndexableKnowledgeChunk


class OpenSearchSchemaError(ValueError):
    """Raised when index documents are incompatible with an index definition."""


class OpenSearchIndexConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    index_name: str = Field(
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
        min_length=1,
    )
    vector_dimension: int = Field(gt=0, le=16_000)

    number_of_shards: int = Field(default=1, gt=0)
    number_of_replicas: int = Field(default=1, ge=0)

    hnsw_m: int = Field(default=16, gt=0)
    hnsw_ef_construction: int = Field(default=128, gt=0)
    schema_version: str = Field(
        default="knowledge-search-v1",
        min_length=1,
    )


def build_index_definition(
    config: OpenSearchIndexConfig,
) -> dict[str, Any]:
    return {
        "settings": {
            "index": {
                "knn": True,
                "number_of_shards": config.number_of_shards,
                "number_of_replicas": config.number_of_replicas,
            }
        },
        "mappings": {
            "dynamic": "strict",
            "properties": {
                "index_document_id": {"type": "keyword"},
                "ingestion_job_id": {"type": "keyword"},
                "knowledge_release_id": {"type": "keyword"},
                "tenant_id": {"type": "keyword"},
                "environment_id": {"type": "keyword"},
                "knowledge_document_id": {"type": "keyword"},
                "source_document_id": {"type": "keyword"},
                "source_version": {"type": "keyword"},
                "chunk_id": {"type": "keyword"},
                "parent_section_id": {"type": "keyword"},
                "chunk_ordinal_within_section": {"type": "integer"},
                "title": {
                    "type": "text",
                    "fields": {
                        "keyword": {
                            "type": "keyword",
                            "ignore_above": 512,
                        }
                    },
                },
                "section_path": {"type": "keyword"},
                "page_start": {"type": "integer"},
                "page_end": {"type": "integer"},
                "content": {"type": "text"},
                "content_sha256": {"type": "keyword", "index": False},
                "source_uri": {"type": "keyword", "index": False},
                "source_content_sha256": {
                    "type": "keyword",
                    "index": False,
                },
                "embedding_vector": {
                    "type": "knn_vector",
                    "dimension": config.vector_dimension,
                    "method": {
                        "name": "hnsw",
                        "engine": "faiss",
                        "space_type": "innerproduct",
                        "parameters": {
                            "m": config.hnsw_m,
                            "ef_construction": (
                                config.hnsw_ef_construction
                            ),
                        },
                    },
                },
                "embedding_model": {
                    "properties": {
                        "provider": {"type": "keyword"},
                        "model_name": {"type": "keyword"},
                        "model_version": {"type": "keyword"},
                        "dimension": {"type": "integer"},
                    }
                },
                "classification": {"type": "keyword"},
                "locale": {"type": "keyword"},
                "effective_from": {"type": "date"},
                "effective_until": {"type": "date"},
                "parser_version": {"type": "keyword"},
                "chunking_strategy_version": {"type": "keyword"},
                "artifact_sha256": {"type": "keyword", "index": False},
            },
            "_meta": {
                        "schema_version": config.schema_version,
                        "vector_dimension": config.vector_dimension,
                    },
        },

    }


def build_bulk_index_payload(
    config: OpenSearchIndexConfig,
    documents: Sequence[IndexableKnowledgeChunk],
) -> list[dict[str, Any]]:
    _validate_documents(config, documents)

    payload: list[dict[str, Any]] = []

    for document in documents:
        payload.append(
            {
                "index": {
                    "_index": config.index_name,
                    "_id": document.index_document_id,
                }
            }
        )
        payload.append(document.model_dump(mode="json"))

    return payload


def _validate_documents(
    config: OpenSearchIndexConfig,
    documents: Sequence[IndexableKnowledgeChunk],
) -> None:
    model_identities = {
        (
            document.embedding_model.provider,
            document.embedding_model.model_name,
            document.embedding_model.model_version,
            document.embedding_model.dimension,
        )
        for document in documents
    }

    if len(model_identities) > 1:
        raise OpenSearchSchemaError(
            "One bulk indexing operation cannot mix embedding models."
        )

    for document in documents:
        if document.embedding_model.dimension != config.vector_dimension:
            raise OpenSearchSchemaError(
                "Embedding model dimension does not match index vector dimension."
            )
