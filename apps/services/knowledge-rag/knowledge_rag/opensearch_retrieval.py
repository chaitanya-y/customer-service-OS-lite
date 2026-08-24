from __future__ import annotations

import math
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .embeddings import EmbeddingModel
from .ingestion import KnowledgeDocumentClassification


class RetrievalQueryError(ValueError):
    """Raised when a retrieval request cannot safely become an OpenSearch query."""


class RetrievalRequest(BaseModel):
    model_config = ConfigDict(frozen=True)

    query_text: str = Field(min_length=1)

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)

    allowed_classifications: list[KnowledgeDocumentClassification] = Field(
        min_length=1
    )
    locale: str = Field(min_length=1)
    as_of: datetime

    embedding_model: EmbeddingModel
    top_k: int = Field(default=5, gt=0, le=50)

    @model_validator(mode="after")
    def validate_as_of_timezone(self) -> RetrievalRequest:
        if self.as_of.tzinfo is None:
            raise ValueError("as_of must include a timezone")

        return self


def build_governance_filters(
    request: RetrievalRequest,
) -> list[dict[str, object]]:
    as_of = request.as_of.isoformat()

    return [
        {"term": {"tenant_id": request.tenant_id}},
        {"term": {"environment_id": request.environment_id}},
        {
            "term": {
                "knowledge_release_id": request.knowledge_release_id
            }
        },
        {
            "terms": {
                "classification": [
                    classification.value
                    for classification in request.allowed_classifications
                ]
            }
        },
        {"term": {"locale": request.locale}},
        _effective_from_filter(as_of),
        _effective_until_filter(as_of),
    ]


def build_filtered_knn_query(
    request: RetrievalRequest,
    query_vector: list[float],
) -> dict[str, object]:
    _validate_query_vector(request, query_vector)
    filter_clauses = build_governance_filters(request)

    return {
        "size": request.top_k,
        "_source": [
            "index_document_id",
            "knowledge_release_id",
            "tenant_id",
            "environment_id",
            "knowledge_document_id",
            "source_document_id",
            "source_version",
            "chunk_id",
            "title",
            "section_path",
            "page_start",
            "page_end",
            "content",
            "content_sha256",
            "source_uri",
            "classification",
            "locale",
            "effective_from",
            "effective_until",
            "parser_version",
            "chunking_strategy_version",
            "artifact_sha256",
        ],
        "query": {
            "knn": {
                "embedding_vector": {
                    "vector": query_vector,
                    "k": request.top_k,
                    "filter": {
                        "bool": {
                            "filter": filter_clauses,
                        }
                    },
                }
            }
        },
    }


def build_filtered_keyword_query(
    request: RetrievalRequest,
) -> dict[str, object]:
    return {
        "size": request.top_k,
        "_source": [
            "index_document_id",
            "knowledge_release_id",
            "tenant_id",
            "environment_id",
            "knowledge_document_id",
            "source_document_id",
            "source_version",
            "chunk_id",
            "title",
            "section_path",
            "page_start",
            "page_end",
            "content",
            "content_sha256",
            "source_uri",
            "classification",
            "locale",
            "effective_from",
            "effective_until",
            "parser_version",
            "chunking_strategy_version",
            "artifact_sha256",
        ],
        "query": {
            "bool": {
                "must": [
                    {
                        "multi_match": {
                            "query": request.query_text,
                            "fields": ["content^3", "title^2"],
                            "type": "best_fields",
                        }
                    }
                ],
                "filter": build_governance_filters(request),
            }
        },
    }


def _validate_query_vector(
    request: RetrievalRequest,
    query_vector: list[float],
) -> None:
    if len(query_vector) != request.embedding_model.dimension:
        raise RetrievalQueryError(
            "Query vector length must match the configured embedding model."
        )

    if not all(math.isfinite(value) for value in query_vector):
        raise RetrievalQueryError("Query vector values must be finite")


def _effective_from_filter(as_of: str) -> dict[str, object]:
    return {
        "bool": {
            "should": [
                {
                    "bool": {
                        "must_not": [
                            {"exists": {"field": "effective_from"}}
                        ]
                    }
                },
                {"range": {"effective_from": {"lte": as_of}}},
            ],
            "minimum_should_match": 1,
        }
    }


def _effective_until_filter(as_of: str) -> dict[str, object]:
    return {
        "bool": {
            "should": [
                {
                    "bool": {
                        "must_not": [
                            {"exists": {"field": "effective_until"}}
                        ]
                    }
                },
                {"range": {"effective_until": {"gt": as_of}}},
            ],
            "minimum_should_match": 1,
        }
    }
