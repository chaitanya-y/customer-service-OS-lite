from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, Field

from .index_documents import IndexableKnowledgeChunk
from .opensearch_schema import (
    OpenSearchIndexConfig,
    build_bulk_index_payload,
    build_index_definition,
)


class OpenSearchIndexingError(RuntimeError):
    """Raised when an OpenSearch indexing operation cannot complete safely."""


class OpenSearchIndexCompatibilityError(OpenSearchIndexingError):
    """Raised when an existing index does not match the expected schema."""


class OpenSearchBulkIndexError(OpenSearchIndexingError):
    """Raised when OpenSearch reports one or more bulk indexing failures."""


class OpenSearchIndicesClient(Protocol):
    def exists(self, *, index: str) -> bool: ...

    def create(
        self,
        *,
        index: str,
        body: Mapping[str, Any],
    ) -> Mapping[str, Any]: ...

    def get_mapping(self, *, index: str) -> Mapping[str, Any]: ...


class OpenSearchClient(Protocol):
    indices: OpenSearchIndicesClient

    def bulk(
        self,
        *,
        body: list[dict[str, Any]],
        refresh: bool,
    ) -> Mapping[str, Any]: ...


class BulkIndexFailure(BaseModel):
    model_config = ConfigDict(frozen=True)

    document_id: str = Field(min_length=1)
    status: int | None = None
    reason: str = Field(min_length=1)


class BulkIndexResult(BaseModel):
    model_config = ConfigDict(frozen=True)

    index_name: str = Field(min_length=1)
    index_created: bool
    documents_indexed: int = Field(ge=0)
    refresh_requested: bool


class OpenSearchIndexingAdapter:
    def __init__(self, client: OpenSearchClient) -> None:
        self._client = client

    def index_documents(
        self,
        *,
        config: OpenSearchIndexConfig,
        documents: Sequence[IndexableKnowledgeChunk],
        refresh: bool = False,
    ) -> BulkIndexResult:
        payload = build_bulk_index_payload(config, documents)
        index_created = self.ensure_index(config)

        if not documents:
            return BulkIndexResult(
                index_name=config.index_name,
                index_created=index_created,
                documents_indexed=0,
                refresh_requested=refresh,
            )

        response = self._client.bulk(body=payload, refresh=refresh)

        if response.get("errors", False):
            failures = _extract_bulk_failures(response)
            failure_summary = "; ".join(
                f"{failure.document_id}: {failure.reason}"
                for failure in failures
            )
            raise OpenSearchBulkIndexError(
                f"OpenSearch bulk indexing failed. {failure_summary}"
            )

        return BulkIndexResult(
            index_name=config.index_name,
            index_created=index_created,
            documents_indexed=len(documents),
            refresh_requested=refresh,
        )

    def ensure_index(self, config: OpenSearchIndexConfig) -> bool:
        if self._client.indices.exists(index=config.index_name):
            self._validate_existing_index(config)
            return False

        expected_definition = build_index_definition(config)

        try:
            self._client.indices.create(
                index=config.index_name,
                body=expected_definition,
            )
            return True
        except Exception as error:
            if not self._client.indices.exists(index=config.index_name):
                raise OpenSearchIndexingError(
                    f"Failed to create index '{config.index_name}'."
                ) from error

            self._validate_existing_index(config)
            return False

    def _validate_existing_index(
        self,
        config: OpenSearchIndexConfig,
    ) -> None:
        mappings_by_index = self._client.indices.get_mapping(
            index=config.index_name
        )

        try:
            actual_meta = mappings_by_index[config.index_name]["mappings"][
                "_meta"
            ]
        except KeyError as error:
            raise OpenSearchIndexCompatibilityError(
                f"Index '{config.index_name}' does not contain CSO schema metadata."
            ) from error

        expected_schema_version = config.schema_version
        actual_schema_version = actual_meta.get("schema_version")
        expected_vector_dimension = config.vector_dimension
        actual_vector_dimension = actual_meta.get("vector_dimension")

        if (
            actual_schema_version != expected_schema_version
            or actual_vector_dimension != expected_vector_dimension
        ):
            raise OpenSearchIndexCompatibilityError(
                f"Index '{config.index_name}' has an incompatible schema. "
                f"Expected version '{expected_schema_version}' with "
                f"vector dimension {expected_vector_dimension}; found version "
                f"'{actual_schema_version}' with vector dimension "
                f"{actual_vector_dimension}."
            )


def _extract_bulk_failures(
    response: Mapping[str, Any],
) -> list[BulkIndexFailure]:
    failures: list[BulkIndexFailure] = []

    for item in response.get("items", []):
        operation = next(iter(item.values()), {})

        if "error" not in operation:
            continue

        error = operation["error"]
        reason = (
            error.get("reason", "Unknown OpenSearch error")
            if isinstance(error, dict)
            else str(error)
        )

        failures.append(
            BulkIndexFailure(
                document_id=operation.get("_id", "unknown-document"),
                status=operation.get("status"),
                reason=reason,
            )
        )

    return failures