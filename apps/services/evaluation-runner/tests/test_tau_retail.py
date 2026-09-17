import pytest

from evaluation_runner.tau_retail import (
    TauRetailCompatibilityAdapter,
    TauRetailTask,
    TauRetailTaskKind,
)


def test_tau_manifest_keeps_official_tasks_separate_from_adapted_internal_cases() -> None:
    manifest = TauRetailCompatibilityAdapter().build_manifest(
        benchmark_version="tau-three-retail-2026-09",
        tasks=[
            TauRetailTask(
                source_task_id="retail-task-001",
                source_task_version="v1",
                kind=TauRetailTaskKind.OFFICIAL,
            ),
            TauRetailTask(
                source_task_id="internal-refund-case-001",
                source_task_version="v1",
                kind=TauRetailTaskKind.ADAPTED_INTERNAL,
                modified=True,
            ),
        ],
    )

    official, adapted = manifest.tasks
    assert official.comparable_to_official is True
    assert adapted.comparable_to_official is False
    assert adapted.kind is TauRetailTaskKind.ADAPTED_INTERNAL


def test_tau_adapter_rejects_an_official_comparability_claim_after_modification() -> None:
    with pytest.raises(ValueError, match="Modified Tau tasks must be labeled adapted"):
        TauRetailTask(
            source_task_id="retail-task-001",
            source_task_version="v1",
            kind=TauRetailTaskKind.OFFICIAL,
            modified=True,
        )


@pytest.mark.parametrize(
    ("task_field", "unsafe_value"),
    [
        ("source_task_id", "retail task CANARY customer message"),
        ("source_task_version", "v1 CANARY tenant record"),
    ],
)
def test_tau_task_rejects_content_bearing_metadata(
    task_field: str,
    unsafe_value: str,
) -> None:
    task = {
        "source_task_id": "retail-task-001",
        "source_task_version": "v1",
        "kind": TauRetailTaskKind.OFFICIAL,
    }
    task[task_field] = unsafe_value

    with pytest.raises(ValueError, match="bounded version or identifier"):
        TauRetailTask(**task)


def test_tau_manifest_rejects_content_bearing_benchmark_version() -> None:
    with pytest.raises(ValueError, match="bounded version or identifier"):
        TauRetailCompatibilityAdapter().build_manifest(
            benchmark_version="2026-09 CANARY customer order",
            tasks=[
                TauRetailTask(
                    source_task_id="retail-task-001",
                    source_task_version="v1",
                    kind=TauRetailTaskKind.OFFICIAL,
                )
            ],
        )
