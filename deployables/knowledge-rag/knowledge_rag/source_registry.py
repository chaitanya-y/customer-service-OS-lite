from __future__ import annotations

from datetime import datetime
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    model_validator,
)

from .ingestion import KnowledgeDocumentClassification
from .models import SourceContentType


class KnowledgeSourceRegistration(BaseModel):
    """
    Trusted metadata for one registered knowledge-source revision.

    This metadata is supplied by the control plane, not extracted from document
    text. The ingestion process verifies the content hash before processing it.
    """

    model_config = ConfigDict(frozen=True)

    knowledge_document_id: str = Field(min_length=1)
    source_document_id: str = Field(min_length=1)
    source_version: str = Field(min_length=1)

    source_uri: str = Field(min_length=1)
    expected_source_content_type: SourceContentType
    expected_source_content_sha256: str = Field(
        pattern=r"^[a-fA-F0-9]{64}$"
    )

    classification: KnowledgeDocumentClassification
    locale: str = Field(min_length=1)
    effective_from: datetime | None = None
    effective_until: datetime | None = None

    @model_validator(mode="after")
    def validate_effective_dates(self) -> KnowledgeSourceRegistration:
        for field_name, timestamp in (
            ("effective_from", self.effective_from),
            ("effective_until", self.effective_until),
        ):
            if timestamp is not None and timestamp.tzinfo is None:
                raise ValueError(
                    f"{field_name} must include a timezone"
                )

        if (
            self.effective_from is not None
            and self.effective_until is not None
            and self.effective_until <= self.effective_from
        ):
            raise ValueError(
                "effective_until must be after effective_from"
            )

        return self


class KnowledgeReleaseManifest(BaseModel):
    """Trusted source registrations for one immutable knowledge release."""

    model_config = ConfigDict(frozen=True)

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    registrations: list[KnowledgeSourceRegistration] = Field(
        min_length=1
    )

    @model_validator(mode="after")
    def validate_registrations(self) -> KnowledgeReleaseManifest:
        document_ids = [
            registration.knowledge_document_id
            for registration in self.registrations
        ]
        if len(set(document_ids)) != len(document_ids):
            raise ValueError(
                "A knowledge release must not contain duplicate "
                "knowledge_document_id values."
            )

        source_revisions = [
            (
                registration.source_document_id,
                registration.source_version,
            )
            for registration in self.registrations
        ]
        if len(set(source_revisions)) != len(source_revisions):
            raise ValueError(
                "A knowledge release must not contain duplicate "
                "source document revisions."
            )

        return self


class KnowledgeSourceManifestError(ValueError):
    """Raised when a trusted knowledge-release manifest cannot be loaded."""


def load_knowledge_release_manifest(
    path: Path,
) -> KnowledgeReleaseManifest:
    try:
        contents = path.read_text(encoding="utf-8")
    except OSError as error:
        raise KnowledgeSourceManifestError(
            f"Could not read knowledge release manifest: {path}"
        ) from error

    try:
        return KnowledgeReleaseManifest.model_validate_json(contents)
    except ValidationError as error:
        raise KnowledgeSourceManifestError(
            f"Knowledge release manifest is invalid: {path}"
        ) from error
