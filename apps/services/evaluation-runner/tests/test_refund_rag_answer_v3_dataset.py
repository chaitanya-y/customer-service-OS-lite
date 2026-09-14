import asyncio
import hashlib
from pathlib import Path

import pytest

from evaluation_runner.adapters.knowledge_answer import KnowledgeAnswerEvaluatedSystem
from evaluation_runner.models import EvaluationDataset
from evaluation_runner.ragas_graders import RagasGrader, RagasMetricName

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "evaluation-datasets"
V1_PATH = FIXTURE_DIR / "refund-rag-answer-v1.json"
V2_PATH = FIXTURE_DIR / "refund-rag-answer-v2.json"
V3_PATH = FIXTURE_DIR / "refund-rag-answer-v3.json"
APPROVED_REFERENCES = {
    "damaged-item-evidence-answer-v1": (
        "For an item that arrived damaged, the policy allows a refund request within "
        "30 calendar days of delivery. The request must identify the order and "
        "affected item. Photo evidence is required before a damaged-item refund can "
        "be approved."
    ),
    "incorrect-item-verification-answer-v1": (
        "The published policy allows a refund request within 30 calendar days of "
        "delivery. Support must verify the order and affected item before considering "
        "the refund."
    ),
    "final-sale-exception-answer-v1": (
        "Final-sale products are excluded unless the item arrived damaged or Acme "
        "sent the wrong item. This describes policy, not this customer’s eligibility."
    ),
    "large-refund-review-answer-v1": (
        "Refunds above the automatic-approval band require human approval or human "
        "takeover, depending on the band. The amount cannot exceed the authoritative "
        "refundable balance."
    ),
    "provider-processing-answer-v1": (
        "After approval, the general policy says refunds go to the original payment "
        "method. Providers may take 5–10 business days to show them; settlement time "
        "is not guaranteed."
    ),
}


def load_dataset(path: Path) -> EvaluationDataset:
    return EvaluationDataset.model_validate_json(path.read_bytes())


def test_v3_changes_only_four_approved_references_and_dataset_version() -> None:
    assert hashlib.sha256(V1_PATH.read_bytes()).hexdigest() == (
        "00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6"
    )
    assert hashlib.sha256(V2_PATH.read_bytes()).hexdigest() == (
        "06679dfeb9e3279c29127233e6b694c3eb4a3c1583e334df3cfe4a37f1c7b7b3"
    )
    previous = load_dataset(V2_PATH)
    revised = load_dataset(V3_PATH)

    expected = previous.model_dump()
    expected["dataset_version"] = "v3"
    for case in expected["cases"]:
        case_id = case["case_id"]
        if case_id != "damaged-item-evidence-answer-v1":
            case["expectations"]["reference"] = APPROVED_REFERENCES[case_id]

    assert revised.model_dump() == expected


@pytest.mark.parametrize("case_id,approved_reference", APPROVED_REFERENCES.items())
def test_v3_reference_reaches_grader_but_not_answer_system_input(
    case_id: str,
    approved_reference: str,
) -> None:
    case = next(case for case in load_dataset(V3_PATH).cases if case.case_id == case_id)
    received_requests = []

    class RecordingExecutor:
        async def execute(self, request, *, repetition: int):
            received_requests.append(request)
            return {
                "response": "A source-supported answer.",
                "evidence": [
                    {
                        "knowledge_document_id": "refund-policy-current-2026-08-01",
                        "chunk_id": "section-003-chunk-001",
                        "content": "Customer-safe policy evidence.",
                        "content_sha256": "a" * 64,
                        "tenant_id": "tenant-local",
                        "environment_id": "local",
                        "knowledge_release_id": "refund-policy-2026-08-01",
                        "classification": "CUSTOMER_SAFE",
                        "locale": "en-US",
                    }
                ],
                "application_facts": ["No refund has been approved."],
                "versions": {"answer_model": "test-model"},
            }

    sample = asyncio.run(
        KnowledgeAnswerEvaluatedSystem(executor=RecordingExecutor()).run(
            case, repetition=1
        )
    )
    assert len(received_requests) == 1
    assert approved_reference not in str(received_requests[0].model_dump(mode="json"))

    captured = {}

    class CaptureScorer:
        async def score(self, metric, **inputs: object) -> float:
            captured.update(inputs)
            return 1.0

    asyncio.run(
        RagasGrader(
            metric=RagasMetricName.FACTUAL_CORRECTNESS,
            scorer=CaptureScorer(),
            minimum=0.7,
        ).grade(case, sample)
    )

    assert captured["reference"] == (
        f"{approved_reference}\n\n"
        "Trusted application facts (not retrieved knowledge):\n"
        "No refund has been approved."
    )
