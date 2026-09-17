"""Offline compatibility labels for tau-three Retail task preparation."""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_SAFE_METADATA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def _safe_metadata(value: str, field_name: str) -> str:
    if not _SAFE_METADATA.fullmatch(value):
        raise ValueError(f"{field_name} must be a bounded version or identifier")
    return value


class TauRetailTaskKind(StrEnum):
    OFFICIAL = "OFFICIAL"
    ADAPTED_INTERNAL = "ADAPTED_INTERNAL"


class TauRetailTask(BaseModel):
    """Content-free identity and provenance for one Tau compatibility entry."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    source_task_id: str = Field(min_length=1, max_length=128)
    source_task_version: str = Field(min_length=1, max_length=128)
    kind: TauRetailTaskKind
    modified: bool = False

    @field_validator("source_task_id", "source_task_version")
    @classmethod
    def validate_safe_metadata(cls, value: str, info) -> str:
        return _safe_metadata(value, info.field_name)

    @model_validator(mode="after")
    def validate_comparability(self) -> TauRetailTask:
        if self.modified and self.kind is TauRetailTaskKind.OFFICIAL:
            raise ValueError("Modified Tau tasks must be labeled adapted internal")
        if self.kind is TauRetailTaskKind.ADAPTED_INTERNAL and not self.modified:
            raise ValueError("Adapted internal Tau tasks must record modification")
        return self


class TauRetailCompatibilityEntry(BaseModel):
    """A non-comparability declaration that carries no benchmark task content."""

    model_config = ConfigDict(frozen=True)

    source_task_id: str = Field(min_length=1, max_length=128)
    source_task_version: str = Field(min_length=1, max_length=128)
    kind: TauRetailTaskKind
    comparable_to_official: bool

    @field_validator("source_task_id", "source_task_version")
    @classmethod
    def validate_safe_metadata(cls, value: str, info) -> str:
        return _safe_metadata(value, info.field_name)


class TauRetailCompatibilityManifest(BaseModel):
    """Offline manifest for keeping official and adapted evaluation results separate."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["tau-retail-compatibility-v1"] = (
        "tau-retail-compatibility-v1"
    )
    benchmark: Literal["tau-three-retail"] = "tau-three-retail"
    benchmark_version: str = Field(min_length=1, max_length=128)
    adapter_version: Literal["tau-retail-adapter-v1"] = "tau-retail-adapter-v1"
    tasks: list[TauRetailCompatibilityEntry] = Field(min_length=1)

    @field_validator("benchmark_version")
    @classmethod
    def validate_safe_metadata(cls, value: str) -> str:
        return _safe_metadata(value, "benchmark_version")


class TauRetailCompatibilityAdapter:
    """Translate task provenance to a content-free compatibility manifest."""

    def build_manifest(
        self,
        *,
        benchmark_version: str,
        tasks: list[TauRetailTask],
    ) -> TauRetailCompatibilityManifest:
        return TauRetailCompatibilityManifest(
            benchmark_version=benchmark_version,
            tasks=[
                TauRetailCompatibilityEntry(
                    source_task_id=task.source_task_id,
                    source_task_version=task.source_task_version,
                    kind=task.kind,
                    comparable_to_official=(
                        task.kind is TauRetailTaskKind.OFFICIAL and not task.modified
                    ),
                )
                for task in tasks
            ],
        )
