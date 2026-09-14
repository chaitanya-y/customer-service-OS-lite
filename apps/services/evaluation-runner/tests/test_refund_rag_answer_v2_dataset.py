import asyncio
import hashlib
from pathlib import Path

import pytest

from evaluation_runner.models import EvaluationDataset, EvaluationSample
from evaluation_runner.ragas_graders import RagasGrader, RagasMetricName

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "evaluation-datasets"
V1_PATH = FIXTURE_DIR / "refund-rag-answer-v1.json"
V2_PATH = FIXTURE_DIR / "refund-rag-answer-v2.json"
DAMAGED_CASE_ID = "damaged-item-evidence-answer-v1"
APPROVED_REFERENCE = (
    "For an item that arrived damaged, the policy allows a refund request within "
    "30 calendar days of delivery. The request must identify the order and "
    "affected item. Photo evidence is required before a damaged-item refund "
    "can be approved."
)


def load_v2() -> EvaluationDataset:
    assert V2_PATH.is_file(), "The approved v2 dataset must exist separately from v1."
    return EvaluationDataset.model_validate_json(V2_PATH.read_text())


def test_v2_changes_only_the_approved_reference_and_dataset_version() -> None:
    historical_bytes = V1_PATH.read_bytes()
    assert hashlib.sha256(historical_bytes).hexdigest() == (
        "00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6"
    )
    historical = EvaluationDataset.model_validate_json(historical_bytes)
    revised = load_v2()

    expected = historical.model_dump()
    expected["dataset_version"] = "v2"
    for case in expected["cases"]:
        if case["case_id"] == DAMAGED_CASE_ID:
            case["expectations"]["reference"] = APPROVED_REFERENCE

    # Protect case membership, inputs, application facts, evidence and safety checks.
    assert revised.model_dump() == expected


@pytest.mark.parametrize(
    "metric",
    [
        RagasMetricName.CONTEXT_PRECISION,
        RagasMetricName.CONTEXT_RECALL,
        RagasMetricName.FACTUAL_CORRECTNESS,
    ],
)
def test_v2_reference_reaches_the_real_grader_boundary(
    metric: RagasMetricName,
) -> None:
    case = next(case for case in load_v2().cases if case.case_id == DAMAGED_CASE_ID)
    captured: dict[str, object] = {}

    class CaptureScorer:
        async def score(self, selected_metric, **inputs: object) -> float:
            assert selected_metric is metric
            captured.update(inputs)
            return 1.0

    application_fact = "No refund has been approved or executed in this evaluation."
    sample = EvaluationSample(
        output={
            "response": "Please identify the order and affected item.",
            "retrieved_contexts": ["Photo evidence is required before approval."],
            "application_facts": [application_fact],
        },
        final_state={"answer_completed": True},
        latency_ms=0,
        versions={"answer_prompt": "refund-answer-v6"},
    )

    asyncio.run(
        RagasGrader(metric=metric, scorer=CaptureScorer(), minimum=0.7).grade(
            case, sample
        )
    )

    expected_reference = APPROVED_REFERENCE
    if metric is RagasMetricName.FACTUAL_CORRECTNESS:
        expected_reference += (
            "\n\nTrusted application facts (not retrieved knowledge):\n"
            + application_fact
        )
    assert captured["reference"] == expected_reference
