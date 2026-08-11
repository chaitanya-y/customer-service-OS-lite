from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SourceContentType(StrEnum):
    PDF = "PDF"
    DOCX = "DOCX"
    HTML = "HTML"
    MARKDOWN = "MARKDOWN"
    TEXT = "TEXT"


class ExtractionWarning(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    page_number: int | None = Field(default=None, gt=0)


class NormalizedSection(BaseModel):
    model_config = ConfigDict(frozen=True)

    section_id: str = Field(min_length=1)
    heading: str = Field(min_length=1)
    heading_path: list[str] = Field(min_length=1)
    text: str = Field(min_length=1)

    page_start: int | None = Field(default=None, gt=0)
    page_end: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def validate_page_range(self) -> "NormalizedSection":
        has_only_one_page_boundary = (self.page_start is None) != (
            self.page_end is None
        )

        if has_only_one_page_boundary:
            raise ValueError("page_start and page_end must be supplied together")

        if (
            self.page_start is not None
            and self.page_end is not None
            and self.page_end < self.page_start
        ):
            raise ValueError("page_end cannot be before page_start")

        return self


class NormalizedDocument(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_uri: str = Field(min_length=1)
    source_content_type: SourceContentType
    source_content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    title: str = Field(min_length=1)
    sections: list[NormalizedSection] = Field(min_length=1)
    extraction_warnings: list[ExtractionWarning] = Field(default_factory=list)

    parser_version: str = Field(min_length=1)