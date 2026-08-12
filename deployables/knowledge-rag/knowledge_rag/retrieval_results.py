from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class RetrievalResponseError(ValueError):
    """Raised when OpenSearch returns a hit without required evidence fields."""


class EvidenceCitation(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_uri: str = Field(min_length=1)
    title: str = Field(min_length=1)
    section_path: list[str] = Field(min_length=1)
    page_start: int | None = Field(default=None, gt=0)
    page_end: int | None = Field(default=None, gt=0)

    def display_location(self) -> str:
        section_location = " > ".join(self.section_path)

        if self.page_start is None:
            return section_location

        if self.page_start == self.page_end:
            return f"{section_location}, page {self.page_start}"

        return f"{section_location}, pages {self.page_start}-{self.page_end}"


class RetrievedEvidence(BaseModel):
    model_config = ConfigDict(frozen=True)

    index_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    retrieval_score: float

    knowledge_release_id: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    classification: str = Field(min_length=1)
    locale: str = Field(min_length=1)

    citation: EvidenceCitation


def to_retrieved_evidence(
    hit: Mapping[str, Any],
) -> RetrievedEvidence:
    source = _required_mapping(hit, "_source")

    return RetrievedEvidence(
        index_document_id=_required_string(source, "index_document_id"),
        chunk_id=_required_string(source, "chunk_id"),
        content=_required_string(source, "content"),
        content_sha256=_required_string(source, "content_sha256"),
        retrieval_score=_required_score(hit),
        knowledge_release_id=_required_string(
            source,
            "knowledge_release_id",
        ),
        tenant_id=_required_string(source, "tenant_id"),
        environment_id=_required_string(source, "environment_id"),
        classification=_required_string(source, "classification"),
        locale=_required_string(source, "locale"),
        citation=EvidenceCitation(
            source_uri=_required_string(source, "source_uri"),
            title=_required_string(source, "title"),
            section_path=_required_string_list(source, "section_path"),
            page_start=_optional_positive_int(source, "page_start"),
            page_end=_optional_positive_int(source, "page_end"),
        ),
    )


def to_retrieved_evidence_list(
    response: Mapping[str, Any],
) -> list[RetrievedEvidence]:
    hits_container = _required_mapping(response, "hits")
    raw_hits = hits_container.get("hits")

    if not isinstance(raw_hits, list):
        raise RetrievalResponseError(
            "OpenSearch response must contain a list at hits.hits."
        )

    return [to_retrieved_evidence(hit) for hit in raw_hits]


def _required_mapping(
    value: Mapping[str, Any],
    field_name: str,
) -> Mapping[str, Any]:
    field_value = value.get(field_name)

    if not isinstance(field_value, Mapping):
        raise RetrievalResponseError(
            f"OpenSearch response field '{field_name}' must be an object."
        )

    return field_value


def _required_string(
    source: Mapping[str, Any],
    field_name: str,
) -> str:
    value = source.get(field_name)

    if not isinstance(value, str) or not value.strip():
        raise RetrievalResponseError(
            f"OpenSearch evidence field '{field_name}' must be a non-empty string."
        )

    return value


def _required_string_list(
    source: Mapping[str, Any],
    field_name: str,
) -> list[str]:
    value = source.get(field_name)

    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) and item.strip() for item in value)
    ):
        raise RetrievalResponseError(
            f"OpenSearch evidence field '{field_name}' must be a non-empty "
            "list of strings."
        )

    return value


def _optional_positive_int(
    source: Mapping[str, Any],
    field_name: str,
) -> int | None:
    value = source.get(field_name)

    if value is None:
        return None

    if not isinstance(value, int) or value <= 0:
        raise RetrievalResponseError(
            f"OpenSearch evidence field '{field_name}' must be a positive integer."
        )

    return value


def _required_score(hit: Mapping[str, Any]) -> float:
    value = hit.get("_score")

    if not isinstance(value, int | float):
        raise RetrievalResponseError(
            "OpenSearch hit field '_score' must be a number."
        )

    return float(value)