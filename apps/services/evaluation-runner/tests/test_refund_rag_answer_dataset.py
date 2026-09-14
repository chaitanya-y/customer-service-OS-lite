from pathlib import Path

from evaluation_runner.models import EvaluationCapability, EvaluationDataset

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-rag-answer-v1.json"
)

EXPECTED_CASE_IDS = [
    "damaged-item-evidence-answer-v1",
    "incorrect-item-verification-answer-v1",
    "final-sale-exception-answer-v1",
    "large-refund-review-answer-v1",
    "provider-processing-answer-v1",
]

EXPECTED_RAGAS_METRICS = [
    "context_precision",
    "context_recall",
    "faithfulness",
    "response_relevancy",
    "factual_correctness",
]


def load_dataset() -> EvaluationDataset:
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def test_refund_rag_answer_dataset_has_stable_reviewed_cases() -> None:
    dataset = load_dataset()

    assert dataset.dataset_id == "tenant-local-refund-rag-answer"
    assert dataset.dataset_version == "v1"
    assert [case.case_id for case in dataset.cases] == EXPECTED_CASE_IDS
    assert all(case.capability is EvaluationCapability.ANSWER for case in dataset.cases)


def test_refund_rag_answer_cases_are_customer_safe_and_auditable() -> None:
    for case in load_dataset().cases:
        assert case.input["tenant_id"] == "tenant-local"
        assert case.input["environment_id"] == "local"
        assert case.input["knowledge_release_id"] == "refund-policy-2026-08-01"
        assert case.input["allowed_classifications"] == ["CUSTOMER_SAFE"]
        assert case.input["locale"] == "en-US"
        system_context = case.input["system_context"]
        assert system_context["order_reference"].startswith("EVAL-")
        assert system_context["item_name"] == "Evaluation item"
        assert system_context["reason_code"]
        assert system_context["scope"] == "FULL_ORDER"
        assert system_context["requested_amount_minor"] > 0

        assert isinstance(case.expectations["reference"], str)
        assert case.expectations["reference"].strip()
        assert case.expectations["forbidden_classifications"] == ["INTERNAL"]
        assert case.expectations["minimum_citation_count"] >= 1
        assert case.expectations["expected_evidence"]
        assert case.expectations["prohibited_claims"]
        assert case.expectations["ragas_metrics"] == EXPECTED_RAGAS_METRICS
        assert case.expectations["semantic_scores_blocking"] is False


def test_large_refund_reference_does_not_disclose_internal_threshold() -> None:
    cases = {case.case_id: case for case in load_dataset().cases}
    reference = cases["large-refund-review-answer-v1"].expectations["reference"]

    assert "500" not in reference
    assert "threshold" not in reference.lower()


def test_answer_references_do_not_determine_personal_delivery_eligibility() -> None:
    cases = {case.case_id: case for case in load_dataset().cases}

    for case_id in [
        "damaged-item-evidence-answer-v1",
        "incorrect-item-verification-answer-v1",
    ]:
        reference = cases[case_id].expectations["reference"]
        assert "delivery date" not in reference.lower()
        assert "you qualify" not in reference.lower()
        assert "your order is eligible" not in reference.lower()
