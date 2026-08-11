from __future__ import annotations

import hashlib
import re

import tiktoken
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .models import NormalizedDocument, NormalizedSection

SENTENCE_BOUNDARY_PATTERN = re.compile(r"(?<=[.!?])\s+")


class ChunkingConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    target_token_count: int = Field(default=450, gt=0)
    overlap_token_count: int = Field(default=60, ge=0)
    tokenizer_name: str = Field(default="cl100k_base", min_length=1)
    chunking_strategy_version: str = Field(
        default="structure-aware-parent-child-v1",
        min_length=1,
    )

    @model_validator(mode="after")
    def validate_token_budget(self) -> ChunkingConfig:
        if self.overlap_token_count >= self.target_token_count:
            raise ValueError(
                "overlap_token_count must be smaller than target_token_count"
            )

        return self


class ChunkDraft(BaseModel):
    model_config = ConfigDict(frozen=True)

    chunk_id: str = Field(min_length=1)
    parent_section_id: str = Field(min_length=1)
    chunk_ordinal_within_section: int = Field(ge=1)

    source_uri: str = Field(min_length=1)
    source_content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")

    title: str = Field(min_length=1)
    section_path: list[str] = Field(min_length=1)
    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    token_count: int = Field(gt=0)

    page_start: int | None = Field(default=None, gt=0)
    page_end: int | None = Field(default=None, gt=0)

    chunking_strategy_version: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_page_range(self) -> ChunkDraft:
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


def chunk_document(
    document: NormalizedDocument,
    config: ChunkingConfig | None = None,
) -> list[ChunkDraft]:
    resolved_config = config or ChunkingConfig()
    encoding = tiktoken.get_encoding(resolved_config.tokenizer_name)

    chunks: list[ChunkDraft] = []

    for section in document.sections:
        chunks.extend(
            _chunk_section(
                document=document,
                section=section,
                config=resolved_config,
                encoding=encoding,
            )
        )

    return chunks


def _chunk_section(
    *,
    document: NormalizedDocument,
    section: NormalizedSection,
    config: ChunkingConfig,
    encoding: tiktoken.Encoding,
) -> list[ChunkDraft]:
    maximum_unit_token_count = (
        config.target_token_count - config.overlap_token_count
    )
    units = _split_into_units(
        section.text,
        encoding=encoding,
        maximum_unit_token_count=maximum_unit_token_count,
    )

    chunk_contents: list[str] = []
    current_content = ""

    for unit in units:
        candidate = _join_text(current_content, unit)

        if (
            current_content
            and _token_count(candidate, encoding) > config.target_token_count
        ):
            chunk_contents.append(current_content)
            current_content = _tail_by_tokens(
                current_content,
                encoding=encoding,
                token_count=config.overlap_token_count,
            )
            candidate = _join_text(current_content, unit)

        if _token_count(candidate, encoding) > config.target_token_count:
            allowed_overlap = max(
                0,
                config.target_token_count - _token_count(unit, encoding),
            )
            current_content = _tail_by_tokens(
                current_content,
                encoding=encoding,
                token_count=allowed_overlap,
            )
            candidate = _join_text(current_content, unit)

        current_content = candidate

    if current_content:
        chunk_contents.append(current_content)

    return [
        _to_chunk_draft(
            document=document,
            section=section,
            content=content,
            chunk_ordinal=chunk_ordinal,
            config=config,
            encoding=encoding,
        )
        for chunk_ordinal, content in enumerate(chunk_contents, start=1)
    ]


def _split_into_units(
    text: str,
    *,
    encoding: tiktoken.Encoding,
    maximum_unit_token_count: int,
) -> list[str]:
    sentences = [
        sentence.strip()
        for sentence in SENTENCE_BOUNDARY_PATTERN.split(text)
        if sentence.strip()
    ]

    units: list[str] = []

    for sentence in sentences:
        if _token_count(sentence, encoding) <= maximum_unit_token_count:
            units.append(sentence)
            continue

        units.extend(
            _split_by_token_budget(
                sentence,
                encoding=encoding,
                token_budget=maximum_unit_token_count,
            )
        )

    return units


def _split_by_token_budget(
    text: str,
    *,
    encoding: tiktoken.Encoding,
    token_budget: int,
) -> list[str]:
    tokens = encoding.encode(text)

    return [
        encoding.decode(tokens[start : start + token_budget]).strip()
        for start in range(0, len(tokens), token_budget)
    ]


def _to_chunk_draft(
    *,
    document: NormalizedDocument,
    section: NormalizedSection,
    content: str,
    chunk_ordinal: int,
    config: ChunkingConfig,
    encoding: tiktoken.Encoding,
) -> ChunkDraft:
    return ChunkDraft(
        chunk_id=f"{section.section_id}-chunk-{chunk_ordinal:03d}",
        parent_section_id=section.section_id,
        chunk_ordinal_within_section=chunk_ordinal,
        source_uri=document.source_uri,
        source_content_sha256=document.source_content_sha256,
        title=document.title,
        section_path=section.heading_path,
        content=content,
        content_sha256=hashlib.sha256(
            content.encode("utf-8")
        ).hexdigest(),
        token_count=_token_count(content, encoding),
        page_start=section.page_start,
        page_end=section.page_end,
        chunking_strategy_version=config.chunking_strategy_version,
    )


def _join_text(left: str, right: str) -> str:
    return right if not left else f"{left} {right}"


def _tail_by_tokens(
    text: str,
    *,
    encoding: tiktoken.Encoding,
    token_count: int,
) -> str:
    if token_count == 0:
        return ""

    tokens = encoding.encode(text)
    return encoding.decode(tokens[-token_count:]).strip()


def _token_count(text: str, encoding: tiktoken.Encoding) -> int:
    return len(encoding.encode(text))