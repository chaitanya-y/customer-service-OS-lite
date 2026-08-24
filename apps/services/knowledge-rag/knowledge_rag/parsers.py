from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from bs4 import BeautifulSoup

from .docx_parser import parse_docx
from .models import NormalizedDocument, NormalizedSection, SourceContentType
from .pdf_parser import parse_pdf

PARSER_VERSION = "parser-v1"

MARKDOWN_HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


class UnsupportedSourceContentTypeError(ValueError):
    """Raised when a parser has not been implemented for a source file type."""


@dataclass
class _SectionAccumulator:
    heading: str
    heading_path: list[str]
    paragraphs: list[str] = field(default_factory=list)


def parse_source(
    source_path: Path,
    *,
    source_uri: str | None = None,
) -> NormalizedDocument:
    source_bytes = source_path.read_bytes()
    source_content_sha256 = hashlib.sha256(source_bytes).hexdigest()
    resolved_source_uri = source_uri or source_path.resolve().as_uri()

    suffix = source_path.suffix.lower()

    if suffix in {".md", ".markdown"}:
        return _parse_markdown(
            source_bytes.decode("utf-8"),
            source_uri=resolved_source_uri,
            source_content_sha256=source_content_sha256,
        )

    if suffix in {".html", ".htm"}:
        return _parse_html(
            source_bytes.decode("utf-8"),
            source_uri=resolved_source_uri,
            source_content_sha256=source_content_sha256,
        )

    if suffix == ".docx":
        return parse_docx(
            source_path,
            source_uri=resolved_source_uri,
            source_content_sha256=source_content_sha256,
        )

    if suffix == ".pdf":
        return parse_pdf(
            source_path,
            source_uri=resolved_source_uri,
            source_content_sha256=source_content_sha256,
        )
    
    if suffix == ".txt":
        return _parse_text(
            source_bytes.decode("utf-8"),
            source_uri=resolved_source_uri,
            source_content_sha256=source_content_sha256,
            title=source_path.stem.replace("-", " ").title(),
        )

    raise UnsupportedSourceContentTypeError(
        f"Parsing is not implemented for '{suffix or 'files without an extension'}'."
    )


def _parse_markdown(
    content: str,
    *,
    source_uri: str,
    source_content_sha256: str,
) -> NormalizedDocument:
    title = ""
    heading_stack: list[str] = []
    sections: list[NormalizedSection] = []
    current_section: _SectionAccumulator | None = None

    def flush_current_section() -> None:
        nonlocal current_section

        if current_section is None or not current_section.paragraphs:
            return

        sections.append(
            NormalizedSection(
                section_id=f"section-{len(sections) + 1:03d}",
                heading=current_section.heading,
                heading_path=current_section.heading_path,
                text="\n\n".join(current_section.paragraphs),
            )
        )
        current_section = None

    for raw_line in content.splitlines():
        line = raw_line.strip()
        heading_match = MARKDOWN_HEADING_PATTERN.match(line)

        if heading_match:
            heading_level = len(heading_match.group(1))
            heading = heading_match.group(2)

            if heading_level == 1:
                flush_current_section()
                title = heading
                heading_stack = [heading]
                continue

            flush_current_section()
            heading_stack = heading_stack[: heading_level - 1]
            heading_stack.append(heading)
            current_section = _SectionAccumulator(
                heading=heading,
                heading_path=heading_stack.copy(),
            )
            continue

        if not line:
            continue

        if current_section is None:
            current_section = _SectionAccumulator(
                heading="Introduction",
                heading_path=["Introduction"],
            )

        current_section.paragraphs.append(line)

    flush_current_section()

    return NormalizedDocument(
        source_uri=source_uri,
        source_content_type=SourceContentType.MARKDOWN,
        source_content_sha256=source_content_sha256,
        title=title or "Untitled Markdown Document",
        sections=sections,
        parser_version=PARSER_VERSION,
    )


def _parse_html(
    content: str,
    *,
    source_uri: str,
    source_content_sha256: str,
) -> NormalizedDocument:
    soup = BeautifulSoup(content, "html.parser")
    root = soup.find("article") or soup.find("main") or soup.body or soup

    title = ""
    heading_stack: list[str] = []
    sections: list[NormalizedSection] = []
    current_section: _SectionAccumulator | None = None

    def flush_current_section() -> None:
        nonlocal current_section

        if current_section is None or not current_section.paragraphs:
            return

        sections.append(
            NormalizedSection(
                section_id=f"section-{len(sections) + 1:03d}",
                heading=current_section.heading,
                heading_path=current_section.heading_path,
                text="\n\n".join(current_section.paragraphs),
            )
        )
        current_section = None

    for element in root.find_all(["h1", "h2", "h3", "h4", "p", "li"]):
        text = " ".join(element.stripped_strings)

        if not text:
            continue

        if element.name in {"h1", "h2", "h3", "h4"}:
            heading_level = int(element.name[1])

            if heading_level == 1:
                flush_current_section()
                title = text
                heading_stack = [text]
                continue

            flush_current_section()
            heading_stack = heading_stack[: heading_level - 1]
            heading_stack.append(text)
            current_section = _SectionAccumulator(
                heading=text,
                heading_path=heading_stack.copy(),
            )
            continue

        if current_section is None:
            current_section = _SectionAccumulator(
                heading="Introduction",
                heading_path=["Introduction"],
            )

        current_section.paragraphs.append(text)

    flush_current_section()

    return NormalizedDocument(
        source_uri=source_uri,
        source_content_type=SourceContentType.HTML,
        source_content_sha256=source_content_sha256,
        title=title or "Untitled HTML Document",
        sections=sections,
        parser_version=PARSER_VERSION,
    )


def _parse_text(
    content: str,
    *,
    source_uri: str,
    source_content_sha256: str,
    title: str,
) -> NormalizedDocument:
    normalized_text = content.strip()

    return NormalizedDocument(
        source_uri=source_uri,
        source_content_type=SourceContentType.TEXT,
        source_content_sha256=source_content_sha256,
        title=title,
        sections=[
            NormalizedSection(
                section_id="section-001",
                heading="Introduction",
                heading_path=["Introduction"],
                text=normalized_text,
            )
        ],
        parser_version=PARSER_VERSION,
    )