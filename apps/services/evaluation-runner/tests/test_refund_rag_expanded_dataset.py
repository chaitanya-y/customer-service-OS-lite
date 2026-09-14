import hashlib
import json
from pathlib import Path

import pytest

from evaluation_runner.models import EvaluationCapability, EvaluationDataset

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "evaluation-datasets"
DEVELOPMENT_PATH = FIXTURE_DIR / "refund-rag-development-v1.json"
HELDOUT_PATH = FIXTURE_DIR / "refund-rag-heldout-v1.json"
SPLITS_PATH = FIXTURE_DIR / "refund-rag-splits-v1.json"
SEED_PATH = FIXTURE_DIR / "refund-rag-answer-v1.json"

EXPECTED_METRICS = [
    "context_precision",
    "context_recall",
    "faithfulness",
    "response_relevancy",
    "factual_correctness",
]
CURRENT_POLICY_DOCUMENT_ID = "refund-policy-current-2026-08-01"
CURRENT_POLICY_CHUNKS = {f"section-{section:03d}-chunk-001" for section in range(2, 10)}


def load_dataset(path: Path) -> EvaluationDataset:
    return EvaluationDataset.model_validate_json(path.read_text())


@pytest.fixture
def datasets() -> tuple[EvaluationDataset, EvaluationDataset, EvaluationDataset]:
    return (
        load_dataset(DEVELOPMENT_PATH),
        load_dataset(HELDOUT_PATH),
        load_dataset(SEED_PATH),
    )


def test_expanded_refund_rag_splits_have_expected_sizes_and_unique_cases(
    datasets: tuple[EvaluationDataset, EvaluationDataset, EvaluationDataset],
) -> None:
    development, heldout, seed = datasets

    assert development.dataset_id == "tenant-local-refund-rag-development"
    assert heldout.dataset_id == "tenant-local-refund-rag-heldout"
    assert development.dataset_version == heldout.dataset_version == "v1"
    assert len(development.cases) == 10
    assert len(heldout.cases) == 5

    development_ids = {case.case_id for case in development.cases}
    heldout_ids = {case.case_id for case in heldout.cases}
    seed_ids = {case.case_id for case in seed.cases}
    assert development_ids.isdisjoint(heldout_ids)
    assert development_ids.isdisjoint(seed_ids)
    assert heldout_ids.isdisjoint(seed_ids)

    normalized_questions = [
        " ".join(case.input["user_input"].lower().split())
        for dataset in (development, heldout, seed)
        for case in dataset.cases
    ]
    assert len(normalized_questions) == len(set(normalized_questions))


def test_expanded_cases_preserve_the_runnable_customer_safe_answer_contract(
    datasets: tuple[EvaluationDataset, EvaluationDataset, EvaluationDataset],
) -> None:
    development, heldout, _ = datasets

    for dataset in (development, heldout):
        for case in dataset.cases:
            assert case.capability is EvaluationCapability.ANSWER
            assert case.input["tenant_id"] == "tenant-local"
            assert case.input["environment_id"] == "local"
            assert case.input["knowledge_release_id"] == "refund-policy-2026-08-01"
            assert case.input["allowed_classifications"] == ["CUSTOMER_SAFE"]
            assert case.input["locale"] == "en-US"
            assert case.input["as_of"] == "2026-08-12T12:00:00Z"

            system_context = case.input["system_context"]
            assert system_context["order_reference"].startswith("EVAL-EXP-")
            assert system_context["item_name"] == "Evaluation item"
            assert system_context["reason_code"]
            assert system_context["scope"] == "FULL_ORDER"
            assert system_context["requested_amount_minor"] > 0

            expectations = case.expectations
            assert expectations["reference"].strip()
            assert (
                expectations["reference_review_status"]
                == "AGENT_AUTHORED_PENDING_OWNER_REVIEW"
            )
            assert expectations["synthetic_facts_status"] == "INDEPENDENT_SYNTHETIC"
            assert expectations["forbidden_classifications"] == ["INTERNAL"]
            assert expectations["minimum_citation_count"] >= 1
            assert expectations["prohibited_claims"]
            assert expectations["ragas_metrics"] == EXPECTED_METRICS
            assert expectations["semantic_scores_blocking"] is False

            evidence = expectations["expected_evidence"]
            assert evidence
            evidence_keys = {
                (item["knowledge_document_id"], item["chunk_id"]) for item in evidence
            }
            assert len(evidence_keys) == len(evidence)
            assert all(
                item["knowledge_document_id"] == CURRENT_POLICY_DOCUMENT_ID
                and item["chunk_id"] in CURRENT_POLICY_CHUNKS
                for item in evidence
            )
            if "negative-or-clarification" in case.tags:
                assert "semantic-interpret-with-care" in case.tags


def test_split_manifest_matches_dataset_membership(
    datasets: tuple[EvaluationDataset, EvaluationDataset, EvaluationDataset],
) -> None:
    development, heldout, seed = datasets
    manifest = json.loads(SPLITS_PATH.read_text())

    assert manifest == {
        "manifest_id": "tenant-local-refund-rag-splits",
        "manifest_version": "v1",
        "seed_dataset": {
            "path": "refund-rag-answer-v1.json",
            "case_ids": [case.case_id for case in seed.cases],
        },
        "development_dataset": {
            "path": "refund-rag-development-v1.json",
            "case_ids": [case.case_id for case in development.cases],
        },
        "heldout_dataset": {
            "path": "refund-rag-heldout-v1.json",
            "case_ids": [case.case_id for case in heldout.cases],
        },
        "authorship": {
            "new_reference_answers": "AGENT_AUTHORED_PENDING_OWNER_REVIEW",
            "system_context": "INDEPENDENT_SYNTHETIC",
        },
        "source_provenance": {
            "path": (
                "apps/services/control-knowledge/fixtures/source-documents/acme/"
                "refund-policy-2026-08-01.md"
            ),
            "source_sha256": (
                "7ea620076fa435d27b88822d4f3e2a97aec1dbb10a11da6d82814bf2932fe943"
            ),
            "knowledge_document_id": CURRENT_POLICY_DOCUMENT_ID,
            "chunk_ids": sorted(CURRENT_POLICY_CHUNKS),
        },
    }

    repository_root = Path(__file__).parents[4]
    source_path = repository_root / manifest["source_provenance"]["path"]
    assert (
        hashlib.sha256(source_path.read_bytes()).hexdigest()
        == (manifest["source_provenance"]["source_sha256"])
    )


def test_adversarial_inputs_are_customer_text_not_trusted_context(
    datasets: tuple[EvaluationDataset, EvaluationDataset, EvaluationDataset],
) -> None:
    development, heldout, _ = datasets
    adversarial_cases = [
        case
        for dataset in (development, heldout)
        for case in dataset.cases
        if "adversarial-input" in case.tags
    ]

    assert {tag for case in adversarial_cases for tag in case.tags} >= {
        "deceptive-claim",
        "irrelevant-information",
        "cross-tenant-request",
        "internal-information-request",
    }
    for case in adversarial_cases:
        assert "adversarial_input" not in case.input["system_context"]
        assert case.input["allowed_classifications"] == ["CUSTOMER_SAFE"]
        assert all(
            evidence["knowledge_document_id"] == CURRENT_POLICY_DOCUMENT_ID
            for evidence in case.expectations["expected_evidence"]
        )
