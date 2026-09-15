import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from evaluation_runner import answer_graders
from evaluation_runner.adapters.knowledge_answer import KnowledgeAnswerEvaluatedSystem
from evaluation_runner.live_rag_evaluation import (
    LiveRagEvaluationConfig,
    LiveRagEvaluationError,
    run_live_rag_evaluation,
)
from evaluation_runner.models import (
    EvaluationCase,
    EvaluationDataset,
    EvaluationSample,
)

FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "evaluation-datasets"
V3_PATH = FIXTURE_DIR / "refund-rag-answer-v3.json"
V4_PATH = FIXTURE_DIR / "refund-rag-answer-v4.json"
CATALOG_SHA256 = "d8d4d4075c18462e9ba455d61edf2b80dd6d89259ff01fadcd5042b35d8bd1e7"
REVIEWED_RESPONSE = (
    "Your requested refund of $750 is above the $500 specialist-review "
    "threshold, so it requires specialist review before it can be approved."
)


def load_dataset(path: Path) -> EvaluationDataset:
    return EvaluationDataset.model_validate_json(path.read_bytes())


def large_case() -> EvaluationCase:
    return next(
        case
        for case in load_dataset(V4_PATH).cases
        if case.case_id == "large-refund-review-answer-v1"
    )


def policy_sample(
    *,
    response: str = REVIEWED_RESPONSE,
    citations: list[dict[str, str]] | None = None,
    versions: dict[str, str] | None = None,
    application_facts: list[str] | None = None,
) -> EvaluationSample:
    return EvaluationSample(
        output={
            "response": response,
            "application_facts": application_facts
            if application_facts is not None
            else [
                "Proposed refund amount: USD 750.00.",
                "Automatic-approval limit: USD 100.00.",
                "Specialist-review threshold: USD 500.00.",
            ],
            "retrieved_contexts": ["Reviewed knowledge context."],
            "retrieved_evidence": [],
            "citations": citations if citations is not None else [],
        },
        final_state={"answer_completed": True},
        latency_ms=1,
        versions=versions
        if versions is not None
        else {
            "refund_policy": "refund-policy-v2",
            "refund_policy_catalog_sha256": CATALOG_SHA256,
        },
    )


def make_policy_grader():
    expectation = answer_graders.read_reviewed_policy_answer(large_case())
    authority = answer_graders.PolicyAnswerAuthority(
        expectation=expectation,
        catalog_sha256=CATALOG_SHA256,
    )
    return answer_graders.ReviewedPolicyAnswerGrader(authority=authority)


def test_v4_changes_only_the_reviewed_large_refund_case() -> None:
    assert hashlib.sha256(V3_PATH.read_bytes()).hexdigest() == (
        "1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de"
    )
    previous = json.loads(V3_PATH.read_bytes())
    revised = json.loads(V4_PATH.read_bytes())

    assert revised["dataset_version"] == "v4"
    assert [case["input"] for case in revised["cases"]] == [
        case["input"] for case in previous["cases"]
    ]
    previous_by_id = {case["case_id"]: case for case in previous["cases"]}
    revised_by_id = {case["case_id"]: case for case in revised["cases"]}
    for case_id, previous_case in previous_by_id.items():
        if case_id != "large-refund-review-answer-v1":
            assert revised_by_id[case_id] == previous_case

    large = revised_by_id["large-refund-review-answer-v1"]
    assert large["expectations"] == {
        "reference": REVIEWED_RESPONSE,
        "expected_evidence": [
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-007-chunk-001",
            }
        ],
        "forbidden_classifications": ["INTERNAL"],
        "minimum_citation_count": 0,
        "prohibited_claims": ["Your refund is automatically approved"],
        "reviewed_policy_answer": {
            "policy_version": "refund-policy-v2",
            "currency": "USD",
            "amount_minor": 75000,
            "automatic_maximum_minor": 10000,
            "approval_maximum_minor": 50000,
            "band": "SPECIALIST_REVIEW",
            "response": REVIEWED_RESPONSE,
        },
        "ragas_metrics": [
            "context_precision",
            "context_recall",
            "faithfulness",
            "response_relevancy",
            "factual_correctness",
        ],
        "semantic_scores_blocking": False,
    }


def test_reviewed_policy_answer_grader_accepts_exact_application_answer() -> None:
    result = asyncio.run(make_policy_grader().grade(large_case(), policy_sample()))

    assert result.passed is True
    assert result.blocking is True
    assert result.score == 1
    assert result.details["observed_policy_version"] == "refund-policy-v2"


@pytest.mark.parametrize(
    ("sample", "reason"),
    [
        (
            policy_sample(versions={"refund_policy_catalog_sha256": CATALOG_SHA256}),
            "policy version",
        ),
        (
            policy_sample(
                versions={
                    "refund_policy": "refund-policy-v1",
                    "refund_policy_catalog_sha256": CATALOG_SHA256,
                }
            ),
            "policy version",
        ),
        (
            policy_sample(versions={"refund_policy": "refund-policy-v2"}),
            "catalog hash",
        ),
        (
            policy_sample(
                versions={
                    "refund_policy": "refund-policy-v2",
                    "refund_policy_catalog_sha256": "a" * 64,
                }
            ),
            "catalog hash",
        ),
        (
            policy_sample(
                application_facts=[
                    "Proposed refund amount: USD 700.00.",
                    "Automatic-approval limit: USD 100.00.",
                    "Specialist-review threshold: USD 500.00.",
                ]
            ),
            "amount fact",
        ),
        (
            policy_sample(
                response=(
                    "Your requested refund of $750 is above the $100 automatic-approval "
                    "limit and at or below the $500 specialist-review threshold, so it "
                    "requires human approval."
                )
            ),
            "reviewed response",
        ),
        (
            policy_sample(
                citations=[
                    {
                        "knowledge_document_id": "refund-policy-current-2026-08-01",
                        "chunk_id": "section-007-chunk-001",
                    }
                ]
            ),
            "zero citations",
        ),
    ],
)
def test_reviewed_policy_answer_grader_blocks_unverified_output(
    sample: EvaluationSample, reason: str
) -> None:
    result = asyncio.run(make_policy_grader().grade(large_case(), sample))

    assert result.passed is False
    assert result.blocking is True
    assert any(reason in item for item in result.reasons)


def test_amount_review_purpose_does_not_exempt_wrong_policy_answer() -> None:
    sample = policy_sample(response="The model selected its amount-review purpose.")
    sample = sample.model_copy(
        update={"output": {**sample.output, "purpose": "amount_review"}}
    )

    result = asyncio.run(make_policy_grader().grade(large_case(), sample))

    assert result.passed is False
    assert any("reviewed response" in item for item in result.reasons)


def test_policy_grader_rejects_conflicting_application_amount_fact() -> None:
    sample = policy_sample(
        application_facts=[
            "Proposed refund amount: USD 750.00.",
            "Proposed refund amount: USD 700.00.",
            "Automatic-approval limit: USD 100.00.",
            "Specialist-review threshold: USD 500.00.",
        ]
    )

    result = asyncio.run(make_policy_grader().grade(large_case(), sample))

    assert result.passed is False
    assert any("amount fact" in item for item in result.reasons)


def test_ordinary_knowledge_case_still_requires_its_reviewed_citation() -> None:
    case = load_dataset(V4_PATH).cases[0]
    result = asyncio.run(
        answer_graders.MinimumCitationCountGrader().grade(
            case,
            policy_sample(citations=[]),
        )
    )

    assert result.passed is False
    assert result.details == {"minimum": 1, "observed": 0}


class RecordingFactory:
    def __init__(self, value) -> None:
        self.value = value
        self.calls = []

    def __call__(self, config):
        self.calls.append(config)
        return self.value


class FakeRagasScorer:
    async def score(self, metric, **inputs: object) -> float:
        assert inputs
        return 1.0


def live_config(tmp_path: Path, dataset_path: Path) -> LiveRagEvaluationConfig:
    return LiveRagEvaluationConfig(
        dataset_path=dataset_path,
        output_path=tmp_path / "result.json",
        knowledge_env_path=tmp_path / "unused.env",
        selected_case_id="large-refund-review-answer-v1",
        answer_model="external-provider-fake",
        judge_model="judge-fake",
        judge_embedding_model="embedding-fake",
        run_id="policy-answer-v4",
        evaluation_version="evaluation-v4",
        allow_paid_api_calls=True,
        refund_policy_version="refund-policy-v2",
    )


@pytest.mark.parametrize(
    ("configured_version", "expected_message"),
    [
        (None, "requires refund_policy_version"),
        ("refund-policy-unknown", "resolve configured refund policy"),
        ("refund-policy-v1", "does not match reviewed policy"),
    ],
)
def test_policy_preflight_rejects_operator_policy_before_clients(
    tmp_path: Path, configured_version: str | None, expected_message: str
) -> None:
    system_factory = RecordingFactory(object())
    scorer_factory = RecordingFactory(object())
    config = live_config(tmp_path, V4_PATH).model_copy(
        update={"refund_policy_version": configured_version}
    )

    with pytest.raises(LiveRagEvaluationError, match=expected_message):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.calls == []
    assert scorer_factory.calls == []


@pytest.mark.parametrize(
    ("field", "value", "expected_message"),
    [
        ("amount_minor", 70000, "does not match case input"),
        ("automatic_maximum_minor", 11000, "resolved policy limits"),
        ("approval_maximum_minor", 60000, "resolved policy limits"),
        ("band", "HUMAN_APPROVAL", "resolved policy band"),
    ],
)
def test_policy_preflight_rejects_stale_reviewed_expectation_before_clients(
    tmp_path: Path, field: str, value: object, expected_message: str
) -> None:
    raw = json.loads(V4_PATH.read_bytes())
    policy_answer = raw["cases"][3]["expectations"]["reviewed_policy_answer"]
    policy_answer[field] = value
    dataset_path = tmp_path / "stale.json"
    dataset_path.write_text(json.dumps(raw))
    system_factory = RecordingFactory(object())
    scorer_factory = RecordingFactory(object())

    with pytest.raises(LiveRagEvaluationError, match=expected_message):
        asyncio.run(
            run_live_rag_evaluation(
                live_config(tmp_path, dataset_path),
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.calls == []
    assert scorer_factory.calls == []


def test_policy_preflight_rejects_zero_amount_before_clients(tmp_path: Path) -> None:
    raw = json.loads(V4_PATH.read_bytes())
    large = raw["cases"][3]
    large["input"]["system_context"]["requested_amount_minor"] = 0
    policy_answer = large["expectations"]["reviewed_policy_answer"]
    policy_answer["amount_minor"] = 0
    policy_answer["band"] = "AUTOMATIC_APPROVAL"
    dataset_path = tmp_path / "zero.json"
    dataset_path.write_text(json.dumps(raw))
    system_factory = RecordingFactory(object())
    scorer_factory = RecordingFactory(object())

    with pytest.raises(LiveRagEvaluationError, match="positive"):
        asyncio.run(
            run_live_rag_evaluation(
                live_config(tmp_path, dataset_path),
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.calls == []
    assert scorer_factory.calls == []


class FakeExternalProviderExecutor:
    async def execute(self, request, *, repetition: int):
        del repetition
        return {
            "response": REVIEWED_RESPONSE,
            "application_facts": [
                "Proposed refund amount: USD 750.00.",
                "Automatic-approval limit: USD 100.00.",
                "Specialist-review threshold: USD 500.00.",
            ],
            "evidence": [
                {
                    "knowledge_document_id": "refund-policy-current-2026-08-01",
                    "chunk_id": "section-007-chunk-001",
                    "content": "Larger refund requests require human review.",
                    "content_sha256": "a" * 64,
                    "tenant_id": request.tenant_id,
                    "environment_id": request.environment_id,
                    "knowledge_release_id": request.knowledge_release_id,
                    "classification": "CUSTOMER_SAFE",
                    "locale": request.locale,
                }
            ],
            "citations": [],
            "versions": {
                "answer_model": "external-provider-fake",
                "refund_policy": "refund-policy-v2",
                "refund_policy_catalog_sha256": CATALOG_SHA256,
            },
        }


@pytest.mark.parametrize("diagnostics_enabled", [False, True])
def test_live_v4_large_case_accepts_real_adapter_and_reviewed_diagnostic_pin(
    tmp_path: Path, diagnostics_enabled: bool
) -> None:
    system = KnowledgeAnswerEvaluatedSystem(executor=FakeExternalProviderExecutor())
    config = live_config(tmp_path, V4_PATH).model_copy(
        update={
            "rejection_diagnostics_path": (
                tmp_path / "rejections.json" if diagnostics_enabled else None
            )
        }
    )
    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(system),
            scorer_factory=RecordingFactory(FakeRagasScorer()),
        )
    )

    trial = result.trials[0]
    assert trial.passed is True
    policy_grade = next(
        grade
        for grade in trial.grader_results
        if grade.grader_name == "answer-reviewed-policy"
    )
    assert policy_grade.passed is True
    assert policy_grade.blocking is True
    assert (tmp_path / "rejections.json").exists() is diagnostics_enabled
