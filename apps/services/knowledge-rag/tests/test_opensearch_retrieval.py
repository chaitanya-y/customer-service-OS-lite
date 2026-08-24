from datetime import UTC, datetime

import pytest

from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from knowledge_rag.opensearch_retrieval import (
    RetrievalQueryError,
    RetrievalRequest,
    build_filtered_keyword_query,
    build_filtered_knn_query,
)


def make_request() -> RetrievalRequest:
    return RetrievalRequest(
        query_text="Can I request a refund after delivery?",
        tenant_id="acme",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=[
            KnowledgeDocumentClassification.CUSTOMER_SAFE
        ],
        locale="en-US",
        as_of=datetime(2026, 8, 11, 12, 0, tzinfo=UTC),
        embedding_model=EmbeddingModel(
            provider="openai",
            model_name="text-embedding-3-small",
            model_version="openai-embeddings-v1",
            dimension=8,
        ),
    )


def test_build_filtered_knn_query_requires_governed_metadata() -> None:
    query = build_filtered_knn_query(make_request(), [0.1] * 8)

    knn_query = query["query"]["knn"]["embedding_vector"]
    filter_clauses = knn_query["filter"]["bool"]["filter"]

    assert query["size"] == 5
    assert knn_query["k"] == 5
    assert {"term": {"tenant_id": "acme"}} in filter_clauses
    assert {"term": {"environment_id": "local"}} in filter_clauses
    assert {
        "term": {
            "knowledge_release_id": "refund-policy-2026-08-01"
        }
    } in filter_clauses
    assert {
        "terms": {"classification": ["CUSTOMER_SAFE"]}
    } in filter_clauses
    assert {"term": {"locale": "en-US"}} in filter_clauses


def test_build_filtered_knn_query_includes_effective_date_filters() -> None:
    query = build_filtered_knn_query(make_request(), [0.1] * 8)

    filter_clauses = query["query"]["knn"]["embedding_vector"]["filter"][
        "bool"
    ]["filter"]

    assert {
        "bool": {
            "should": [
                {
                    "bool": {
                        "must_not": [
                            {"exists": {"field": "effective_from"}}
                        ]
                    }
                },
                {
                    "range": {
                        "effective_from": {
                            "lte": "2026-08-11T12:00:00+00:00"
                        }
                    }
                },
            ],
            "minimum_should_match": 1,
        }
    } in filter_clauses


def test_build_filtered_knn_query_rejects_wrong_vector_length() -> None:
    with pytest.raises(
        RetrievalQueryError,
        match="length must match the configured embedding model",
    ):
        build_filtered_knn_query(make_request(), [0.1] * 7)


def test_retrieval_request_rejects_time_without_timezone() -> None:
    request_data = make_request().model_dump()
    request_data["as_of"] = datetime(2026, 8, 11, 12, 0)  # noqa: DTZ001

    with pytest.raises(ValueError, match="as_of must include a timezone"):
        RetrievalRequest(**request_data)

def test_keyword_query_uses_the_same_governance_filters_as_vector_search() -> None:
    request = make_request()

    keyword_query = build_filtered_keyword_query(request)
    vector_query = build_filtered_knn_query(request, [0.1] * 8)

    assert keyword_query["query"]["bool"]["filter"] == vector_query[
        "query"
    ]["knn"]["embedding_vector"]["filter"]["bool"]["filter"]


def test_keyword_query_prioritizes_policy_content_and_title() -> None:
    query = build_filtered_keyword_query(make_request())

    multi_match = query["query"]["bool"]["must"][0]["multi_match"]

    assert multi_match["query"] == "Can I request a refund after delivery?"
    assert multi_match["fields"] == ["content^3", "title^2"]
    assert multi_match["type"] == "best_fields"