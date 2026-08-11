from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader

from .models import (
    ExtractionWarning,
    NormalizedDocument,
    NormalizedSection,
    SourceContentType,
)

PARSER_VERSION = "parser-v1"


class EncryptedPdfError(ValueError):
    """Raised when a PDF needs a password and cannot be safely parsed."""


def parse_pdf(
    source_path: Path,
    *,
    source_uri: str,
    source_content_sha256: str,
) -> NormalizedDocument:
    reader = PdfReader(source_path)

    if reader.is_encrypted:
        raise EncryptedPdfError(
            "Encrypted PDFs are not supported by the ingestion parser."
        )

    title = _resolve_title(reader, source_path)
    sections: list[NormalizedSection] = []
    warnings: list[ExtractionWarning] = [
        ExtractionWarning(
            code="PDF_LAYOUT_SEMANTICS_UNAVAILABLE",
            message=(
                "PDF parsing preserves page locations, but it does not infer "
                "visual heading structure from page layout."
            ),
        )
    ]

    for page_number, page in enumerate(reader.pages, start=1):
        text = _normalize_page_text(page.extract_text() or "")

        if not text:
            warnings.append(
                ExtractionWarning(
                    code="PDF_PAGE_EMPTY",
                    message="Page contained no extractable text.",
                    page_number=page_number,
                )
            )
            continue

        sections.append(
            NormalizedSection(
                section_id=f"page-{page_number:03d}",
                heading=f"Page {page_number}",
                heading_path=[title, f"Page {page_number}"],
                text=text,
                page_start=page_number,
                page_end=page_number,
            )
        )

    if not sections:
        raise ValueError("PDF contained no extractable text.")

    return NormalizedDocument(
        source_uri=source_uri,
        source_content_type=SourceContentType.PDF,
        source_content_sha256=source_content_sha256,
        title=title,
        sections=sections,
        extraction_warnings=warnings,
        parser_version=PARSER_VERSION,
    )


def _resolve_title(reader: PdfReader, source_path: Path) -> str:
    metadata_title = reader.metadata.title if reader.metadata else None

    if metadata_title and metadata_title.strip():
        return metadata_title.strip()

    return source_path.stem.replace("-", " ").title()


def _normalize_page_text(text: str) -> str:
    return "\n".join(
        line.strip()
        for line in text.splitlines()
        if line.strip()
    )