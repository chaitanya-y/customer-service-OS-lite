import asyncio
import json
import stat
from pathlib import Path

import pytest

import evaluation_runner.live_rag_evaluation as live_module
from evaluation_runner.live_rag_evaluation import (
    LiveRagEvaluationConfig,
    LiveRagEvaluationError,
    SyntheticRejectionDiagnosticSidecar,
    run_live_rag_evaluation,
)
from evaluation_runner.models import EvaluationRun, EvaluationSample, TrialStatus
from evaluation_runner.usage import (
    EvaluationUsageReport,
    UsageComponent,
    UsageRecorder,
)


class FakeAnswerSystem:
    def __init__(self) -> None:
        self.case_ids: list[str] = []

    async def run(self, case, *, repetition: int) -> EvaluationSample:
        self.case_ids.append(case.case_id)
        return EvaluationSample(
            output={
                "response": "Damage photos are required before review.",
                "retrieved_contexts": [
                    "Photo evidence is required before a damaged-item refund."
                ],
                "retrieved_evidence": [
                    {
                        "rank": 1,
                        "knowledge_document_id": "refund-policy",
                        "chunk_id": "damaged-item",
                        "content_sha256": "a" * 64,
                        "classification": "CUSTOMER_SAFE",
                    }
                ],
                "citations": [
                    {
                        "knowledge_document_id": "refund-policy",
                        "chunk_id": "damaged-item",
                    }
                ],
            },
            final_state={"answer_completed": True},
            latency_ms=12.0,
            versions={"answer_model": "fake-answer-v1"},
        )


class FakeRagasScorer:
    def __init__(self) -> None:
        self.calls: list[tuple[object, dict[str, object]]] = []

    async def score(self, metric, **inputs: object) -> float:
        self.calls.append((metric, inputs))
        assert inputs
        return 0.8


class RecordingFactory:
    def __init__(self, value) -> None:
        self.value = value
        self.configs: list[LiveRagEvaluationConfig] = []

    def __call__(self, config: LiveRagEvaluationConfig):
        self.configs.append(config)
        return self.value


def write_dataset(path: Path) -> None:
    path.write_text(
        """{
  "dataset_id": "answer-test",
  "dataset_version": "v1",
  "cases": [
    {
      "case_id": "case-a",
      "name": "First case",
      "capability": "ANSWER",
      "input": {
        "user_input": "Question A",
        "tenant_id": "tenant-local",
        "environment_id": "local",
        "knowledge_release_id": "release-v1",
        "allowed_classifications": ["CUSTOMER_SAFE"],
        "locale": "en-US",
        "as_of": "2026-09-06T12:00:00Z"
      },
      "expectations": {
        "reference": "Reference A",
        "expected_evidence": [{
          "knowledge_document_id": "refund-policy",
          "chunk_id": "damaged-item"
        }],
        "minimum_citation_count": 1,
        "prohibited_claims": ["Your refund is approved"],
        "ragas_metrics": ["faithfulness"],
        "semantic_scores_blocking": false
      }
    },
    {
      "case_id": "case-b",
      "name": "Second case",
      "capability": "ANSWER",
      "input": {
        "user_input": "Question B",
        "tenant_id": "tenant-local",
        "environment_id": "local",
        "knowledge_release_id": "release-v1",
        "allowed_classifications": ["CUSTOMER_SAFE"],
        "locale": "en-US",
        "as_of": "2026-09-06T12:00:00Z"
      },
      "expectations": {
        "reference": "Reference B",
        "expected_evidence": [{
          "knowledge_document_id": "refund-policy",
          "chunk_id": "damaged-item"
        }],
        "minimum_citation_count": 1,
        "prohibited_claims": ["Your refund is approved"],
        "ragas_metrics": ["faithfulness"],
        "semantic_scores_blocking": false
      }
    }
  ]
}"""
    )


def make_config(
    tmp_path: Path, *, allow_paid_api_calls: bool
) -> LiveRagEvaluationConfig:
    dataset_path = tmp_path / "dataset.json"
    write_dataset(dataset_path)
    knowledge_env_path = tmp_path / "knowledge.env"
    knowledge_env_path.write_text("OPENAI_API_KEY=test-only-placeholder\n")
    return LiveRagEvaluationConfig(
        dataset_path=dataset_path,
        output_path=tmp_path / "result.json",
        knowledge_env_path=knowledge_env_path,
        selected_case_id="case-b",
        answer_model="answer-model-v1",
        judge_model="judge-model-v1",
        judge_embedding_model="embedding-model-v1",
        run_id="ragas-smoke-001",
        evaluation_version="ragas-evaluation-v1",
        allow_paid_api_calls=allow_paid_api_calls,
    )


def make_diagnostic_config(
    tmp_path: Path, *, dataset_version: str = "v1"
) -> LiveRagEvaluationConfig:
    fixture_path = (
        Path(live_module.__file__).resolve().parent.parent
        / "fixtures"
        / "evaluation-datasets"
        / f"refund-rag-answer-{dataset_version}.json"
    )
    config = make_config(tmp_path, allow_paid_api_calls=True)
    return config.model_copy(
        update={
            "dataset_path": fixture_path,
            "selected_case_id": "damaged-item-evidence-answer-v1",
            "rejection_diagnostics_path": tmp_path / "rejections.json",
        }
    )


def test_live_run_refuses_before_constructing_external_clients(tmp_path: Path) -> None:
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())
    config = make_config(tmp_path, allow_paid_api_calls=False)

    with pytest.raises(LiveRagEvaluationError, match="ALLOW_PAID_API_CALLS"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []
    assert not config.output_path.exists()


def test_diagnostic_mode_rejects_non_builtin_dataset_before_clients(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"rejection_diagnostics_path": tmp_path / "rejections.json"}
    )
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="built-in reviewed synthetic"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


@pytest.mark.parametrize("dataset_version", ["v1", "v2", "v3"])
def test_diagnostic_mode_rejects_changed_builtin_dataset_before_clients(
    monkeypatch,
    tmp_path: Path,
    dataset_version: str,
) -> None:
    config = make_diagnostic_config(tmp_path, dataset_version=dataset_version)
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())
    original_read_bytes = Path.read_bytes
    reviewed_path = config.dataset_path.resolve(strict=True)

    def read_tampered_dataset(path: Path) -> bytes:
        dataset_json = original_read_bytes(path)
        if path.resolve(strict=True) == reviewed_path:
            return dataset_json + b"\n"
        return dataset_json

    monkeypatch.setattr(Path, "read_bytes", read_tampered_dataset)

    with pytest.raises(LiveRagEvaluationError, match="reviewed content pin"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


@pytest.mark.parametrize("dataset_version", ["v1", "v2", "v3"])
def test_diagnostic_mode_rejects_copied_reviewed_dataset_before_clients(
    tmp_path: Path,
    dataset_version: str,
) -> None:
    config = make_diagnostic_config(
        tmp_path, dataset_version=dataset_version
    ).model_copy(update={"dataset_path": tmp_path / "copied-dataset.json"})
    source_path = (
        Path(live_module.__file__).resolve().parent.parent
        / "fixtures"
        / "evaluation-datasets"
        / f"refund-rag-answer-{dataset_version}.json"
    )
    config.dataset_path.write_bytes(source_path.read_bytes())
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="built-in reviewed synthetic"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


def test_diagnostic_mode_refuses_existing_sidecar_before_clients(
    tmp_path: Path,
) -> None:
    config = make_diagnostic_config(tmp_path)
    assert config.rejection_diagnostics_path is not None
    config.rejection_diagnostics_path.write_text("do not overwrite")
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="already exists"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert config.rejection_diagnostics_path.read_text() == "do not overwrite"
    assert system_factory.configs == []
    assert scorer_factory.configs == []


def test_diagnostic_mode_refuses_existing_result_before_clients(
    tmp_path: Path,
) -> None:
    config = make_diagnostic_config(tmp_path)
    config.output_path.write_text("do not overwrite")
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="result output.*already exists"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert config.output_path.read_text() == "do not overwrite"
    assert system_factory.configs == []
    assert scorer_factory.configs == []


def test_diagnostic_mode_requires_result_directory_before_clients(
    tmp_path: Path,
) -> None:
    config = make_diagnostic_config(tmp_path).model_copy(
        update={"output_path": tmp_path / "missing" / "result.json"}
    )
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="output directory"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


@pytest.mark.parametrize("dangling_symlink", [False, True])
def test_diagnostic_mode_refuses_existing_result_staging_path_before_clients(
    tmp_path: Path,
    dangling_symlink: bool,
) -> None:
    config = make_diagnostic_config(tmp_path)
    staging_path = config.output_path.with_suffix(f"{config.output_path.suffix}.tmp")
    if dangling_symlink:
        staging_path.symlink_to(tmp_path / "missing-target")
    else:
        staging_path.write_text("do not overwrite")
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(
        LiveRagEvaluationError, match="temporary output.*already exists"
    ):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


@pytest.mark.parametrize("alias_kind", ["result", "result_temporary"])
def test_diagnostic_mode_rejects_result_path_aliases_before_clients(
    tmp_path: Path,
    alias_kind: str,
) -> None:
    config = make_diagnostic_config(tmp_path)
    if alias_kind == "result":
        alias_path = config.output_path.parent / "." / config.output_path.name
    else:
        alias_path = config.output_path.with_suffix(f"{config.output_path.suffix}.tmp")
    config = config.model_copy(update={"rejection_diagnostics_path": alias_path})
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="must not alias"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


@pytest.mark.parametrize("dataset_version", ["v1", "v2", "v3"])
def test_diagnostic_mode_parses_the_same_bytes_that_passed_the_content_pin(
    monkeypatch,
    tmp_path: Path,
    dataset_version: str,
) -> None:
    config = make_diagnostic_config(tmp_path, dataset_version=dataset_version)
    original_read_text = Path.read_text
    reviewed_path = config.dataset_path.resolve(strict=True)

    def reject_second_dataset_read(path: Path, *args, **kwargs) -> str:
        if path.resolve(strict=True) == reviewed_path:
            raise AssertionError("reviewed dataset was read again after pin validation")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", reject_second_dataset_read)

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FakeAnswerSystem()),
            scorer_factory=RecordingFactory(FakeRagasScorer()),
        )
    )

    assert result.dataset_id == "tenant-local-refund-rag-answer"


@pytest.mark.parametrize("dataset_version", ["v1", "v2", "v3"])
def test_rejected_answer_diagnostic_is_separate_and_never_graded(
    tmp_path: Path,
    dataset_version: str,
) -> None:
    pytest.importorskip("agent_runtime")
    from agent_runtime.refund.answer import RefundAnswerRejectionCode

    from evaluation_runner.adapters.refund_rag_answer import (
        RefundAnswerRejectionDiagnostic,
        RefundRagAnswerExecutorError,
        RejectedAnswerEvidence,
    )

    config = make_diagnostic_config(tmp_path, dataset_version=dataset_version)
    scorer = FakeRagasScorer()
    diagnostic = RefundAnswerRejectionDiagnostic(
        stage="ANSWER_COMPOSITION_POST_MODEL_VALIDATION",
        rejection_code=RefundAnswerRejectionCode.MONEY_TEXT_REJECTED,
        response="Your USD 120.00 refund is approved.",
        response_sha256=(
            "6f5ab8e7e2ad0afacebb89e15162ba7055854028b11846e81532bd2cb2fcc7a8"
        ),
        citations=[
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
            }
        ],
        evidence=[
            RejectedAnswerEvidence(
                rank=1,
                knowledge_document_id="refund-policy-current-2026-08-01",
                chunk_id="section-003-chunk-001",
                content_sha256="a" * 64,
                classification="CUSTOMER_SAFE",
            )
        ],
        versions={
            "answer_model": "answer-model-v1",
            "answer_prompt": "refund-answer-v6",
            "embedding_model": "fake:embedding:v1:3",
            "knowledge_release": "refund-policy-2026-08-01",
            "reranker_model": "fake:reranker:v1",
        },
    )

    class RejectingSystem:
        async def run(self, case, *, repetition: int):
            raise RefundRagAnswerExecutorError(
                "Customer answer rejected: MONEY_TEXT_REJECTED.",
                rejection_diagnostic=diagnostic,
            )

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(RejectingSystem()),
            scorer_factory=RecordingFactory(scorer),
        )
    )

    trial = result.trials[0]
    assert trial.status is TrialStatus.SYSTEM_ERROR
    assert trial.sample is None
    assert trial.grader_results == []
    assert scorer.calls == []
    assert "USD 120.00" not in config.output_path.read_text()

    assert config.rejection_diagnostics_path is not None
    persisted = SyntheticRejectionDiagnosticSidecar.model_validate_json(
        config.rejection_diagnostics_path.read_text()
    )
    assert persisted.run_id == config.run_id
    assert persisted.dataset_id == "tenant-local-refund-rag-answer"
    assert persisted.dataset_version == dataset_version
    assert persisted.evaluation_version == config.evaluation_version
    assert len(persisted.rejections) == 1
    rejection = persisted.rejections[0]
    assert rejection.trial_id == ("ragas-smoke-001:damaged-item-evidence-answer-v1:1")
    assert rejection.case_id == "damaged-item-evidence-answer-v1"
    assert rejection.repetition == 1
    assert rejection.response == "Your USD 120.00 refund is approved."
    assert "Photo evidence" not in config.rejection_diagnostics_path.read_text()
    assert stat.S_IMODE(config.rejection_diagnostics_path.stat().st_mode) == 0o600


def _make_delivery_age_rejecting_answer_system():
    from agent_runtime.config import RefundProposalSettings
    from agent_runtime.refund.answer import LangChainRefundAnswerComposer
    from agent_runtime.refund.proposal import RefundProposalBuilder
    from knowledge_rag.embeddings import EmbeddingModel
    from knowledge_rag.hybrid_retrieval import FusedEvidence
    from knowledge_rag.reranking import RerankedEvidence, RerankerModel
    from knowledge_rag.retrieval_results import EvidenceCitation, RetrievedEvidence
    from knowledge_rag.retrieval_service import RetrievalExecutionResult

    from evaluation_runner.adapters.knowledge_answer import (
        KnowledgeAnswerEvaluatedSystem,
    )
    from evaluation_runner.adapters.refund_rag_answer import RefundRagAnswerExecutor

    class RejectingModel:
        def with_structured_output(self, *args, **kwargs):
            del args, kwargs
            return self

        async def ainvoke(self, messages):
            del messages
            return {
                "message": (
                    "The policy allows damaged-item refund requests within "
                    "30 calendar days of delivery."
                ),
                "citations": [],
            }

    class CustomerSafeRetrieval:
        def retrieve(self, request):
            evidence = RetrievedEvidence(
                index_document_id="knowledge-001",
                knowledge_document_id="refund-policy-current-2026-08-01",
                chunk_id="section-003-chunk-001",
                content=(
                    "Damaged items may be refunded within 30 calendar days of "
                    "delivery. Photo evidence is required before approval."
                ),
                content_sha256="a" * 64,
                retrieval_score=1.0,
                knowledge_release_id=request.knowledge_release_id,
                tenant_id=request.tenant_id,
                environment_id=request.environment_id,
                classification="CUSTOMER_SAFE",
                locale=request.locale,
                citation=EvidenceCitation(
                    source_uri="s3://synthetic/refund-policy.md",
                    title="Refund policy",
                    section_path=["Damaged items"],
                ),
            )
            reranker = RerankerModel(
                provider="fake", model_name="reranker", model_version="v1"
            )
            return RetrievalExecutionResult(
                request=request,
                embedding_model=request.embedding_model,
                reranker_model=reranker,
                fused_candidate_count=1,
                evidence=[
                    RerankedEvidence(
                        fused_evidence=FusedEvidence(
                            evidence=evidence,
                            reciprocal_rank_fusion_score=0.5,
                            contributing_retrievers=["semantic_vector"],
                        ),
                        reranker_score=0.9,
                        reranker_rank=1,
                        reranker_model=reranker,
                    )
                ],
            )

    return KnowledgeAnswerEvaluatedSystem(
        executor=RefundRagAnswerExecutor(
            retrieval_executor=CustomerSafeRetrieval(),
            embedding_model=EmbeddingModel(
                provider="fake", model_name="embedding", model_version="v1", dimension=3
            ),
            answer_composer=LangChainRefundAnswerComposer(
                RejectingModel(),  # type: ignore[arg-type]
                capture_rejected_answer=True,
            ),
            proposal_builder=RefundProposalBuilder(
                versions=RefundProposalSettings(
                    agent_release_id="agent-runtime-evaluation",
                    prompt_bundle_version="refund-answer-v4",
                    model_route_id="refund-answer-evaluation",
                    knowledge_release_id="refund-policy-2026-08-01",
                    evaluation_version="ragas-evaluation-v1",
                ).to_versions(),
                create_id=lambda: "evaluation-id",
            ),
            answer_model="fake-answer-model",
        )
    )


@pytest.mark.parametrize("dataset_version", ["v2", "v3"])
def test_reviewed_dataset_rejection_flows_through_real_answer_boundary_without_grading(
    tmp_path: Path, dataset_version: str
) -> None:
    pytest.importorskip("agent_runtime")
    config = make_diagnostic_config(tmp_path, dataset_version=dataset_version)
    scorer = FakeRagasScorer()

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(
                _make_delivery_age_rejecting_answer_system()
            ),
            scorer_factory=RecordingFactory(scorer),
        )
    )

    trial = result.trials[0]
    assert trial.status is TrialStatus.SYSTEM_ERROR
    assert trial.sample is None
    assert trial.grader_results == []
    assert scorer.calls == []
    assert config.rejection_diagnostics_path is not None
    sidecar = SyntheticRejectionDiagnosticSidecar.model_validate_json(
        config.rejection_diagnostics_path.read_text()
    )
    assert sidecar.dataset_version == dataset_version
    assert sidecar.rejections[0].rejection_code == "DELIVERY_AGE_TEXT_REJECTED"
    assert sidecar.rejections[0].evidence[0].classification == "CUSTOMER_SAFE"
    assert "Photo evidence" not in config.rejection_diagnostics_path.read_text()
    assert stat.S_IMODE(config.rejection_diagnostics_path.stat().st_mode) == 0o600


def test_fatal_judge_failure_writes_neither_result_nor_diagnostics(
    tmp_path: Path,
) -> None:
    config = make_diagnostic_config(tmp_path)

    class FailingScorer:
        async def score(self, metric, **inputs: object) -> float:
            raise RuntimeError("judge unavailable")

    with pytest.raises(LiveRagEvaluationError, match="Fatal evaluation error"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=RecordingFactory(FakeAnswerSystem()),
                scorer_factory=RecordingFactory(FailingScorer()),
            )
        )

    assert not config.output_path.exists()
    assert config.rejection_diagnostics_path is not None
    assert not config.rejection_diagnostics_path.exists()


def test_live_factory_enables_composer_capture_only_for_diagnostic_mode(
    monkeypatch,
    tmp_path: Path,
) -> None:
    pytest.importorskip("agent_runtime")
    calls: list[bool] = []

    class RecordingComposer:
        def __init__(self, model, *, capture_rejected_answer: bool = False) -> None:
            del model
            calls.append(capture_rejected_answer)

    monkeypatch.setattr(
        "agent_runtime.refund.answer.LangChainRefundAnswerComposer",
        RecordingComposer,
    )

    class FakeSettings:
        openai_api_key = type(
            "Key", (), {"get_secret_value": lambda self: "test-placeholder"}
        )()
        knowledge_index_name = "test-index"
        knowledge_release_id = "refund-policy-2026-08-01"
        customer_evidence_top_k = 3

        def __init__(self, **kwargs) -> None:
            del kwargs

    class FakeEmbeddingProvider:
        model = object()

        def __init__(self, **kwargs) -> None:
            del kwargs

    class FakeDependency:
        def __init__(self, *args, **kwargs) -> None:
            del args, kwargs

    monkeypatch.setattr("knowledge_rag.config.KnowledgeRetrievalSettings", FakeSettings)
    monkeypatch.setattr(
        "knowledge_rag.embeddings.OpenAIEmbeddingProvider", FakeEmbeddingProvider
    )
    monkeypatch.setattr(
        "knowledge_rag.opensearch_local.create_local_opensearch_client", object
    )
    monkeypatch.setattr(
        "knowledge_rag.reranking.SentenceTransformersCrossEncoderProvider",
        FakeDependency,
    )
    monkeypatch.setattr(
        "knowledge_rag.retrieval_service.KnowledgeRetrievalService", FakeDependency
    )
    monkeypatch.setattr("langchain_openai.ChatOpenAI", FakeDependency)

    live_module.create_live_refund_answer_system(
        make_config(tmp_path, allow_paid_api_calls=True)
    )
    live_module.create_live_refund_answer_system(make_diagnostic_config(tmp_path))

    assert calls == [False, True]


def test_live_judge_sends_explicit_completion_budget_through_ragas(
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("RAGAS_DO_NOT_TRACK", "true")
    pytest.importorskip("ragas")
    import httpx
    import openai

    from evaluation_runner.ragas_graders import RagasMetricName

    requests: list[dict] = []
    clients: list[openai.AsyncOpenAI] = []
    usage_recorder = UsageRecorder()

    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(
            200,
            json={
                "id": "offline-judge-completion",
                "object": "chat.completion",
                "created": 0,
                "model": "gpt-5-nano",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {
                                    "reason": "The passage explains required damage photos.",
                                    "verdict": 1,
                                }
                            ),
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 10,
                    "total_tokens": 20,
                },
            },
        )

    class OfflineOpenAI(openai.AsyncOpenAI):
        def __init__(self, **kwargs) -> None:
            super().__init__(
                **kwargs,
                http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
                max_retries=0,
            )
            clients.append(self)

    monkeypatch.setattr(openai, "AsyncOpenAI", OfflineOpenAI)
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"judge_model": "gpt-5-nano"}
    )
    config.knowledge_env_path.write_text(
        "OPENAI_API_KEY=test-only-placeholder\n"
        "TENANT_ID=tenant-local\n"
        "ENVIRONMENT_ID=local\n"
        "CONTEXT_ASSERTION_HMAC_SECRET=test-only-signing-secret-not-for-use\n"
        "CONTEXT_ASSERTION_ISSUER=test-issuer\n"
        "KNOWLEDGE_RELEASE_ID=release-v1\n"
        "KNOWLEDGE_INDEX_NAME=test-index\n"
    )

    async def evaluate() -> float:
        try:
            scorer = live_module.create_live_ragas_scorer(
                config,
                usage_recorder=usage_recorder,
            )
            return await scorer.score(
                RagasMetricName.CONTEXT_PRECISION,
                user_input="Do you need photos of my damaged item?",
                retrieved_contexts=["Damage photos are required before review."],
                reference="Please provide photos showing the damage.",
            )
        finally:
            for client in clients:
                await client.close()

    assert asyncio.run(evaluate()) == pytest.approx(1.0)
    assert len(requests) == 1
    assert requests[0]["model"] == "gpt-5-nano"
    assert requests[0]["max_completion_tokens"] == 4096
    assert "max_tokens" not in requests[0]
    report = usage_recorder.build_report(
        run_id=config.run_id,
        evaluation_version=config.evaluation_version,
        run_succeeded=True,
    )
    judge_usage = next(item for item in report.components if item.component == "judge")
    assert judge_usage.total_tokens == 20


def test_live_answer_factory_records_query_and_answer_usage_from_sdk_transport(
    monkeypatch,
    tmp_path: Path,
) -> None:
    pytest.importorskip("agent_runtime")
    import httpx
    import openai
    from pydantic import SecretStr

    recorder = UsageRecorder()
    captured: dict[str, object] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/embeddings"):
            return httpx.Response(
                200,
                json={
                    "object": "list",
                    "model": "text-embedding-3-small",
                    "data": [
                        {"object": "embedding", "index": 0, "embedding": [0.0] * 1536}
                    ],
                    "usage": {"prompt_tokens": 4, "total_tokens": 4},
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "offline-answer",
                "object": "chat.completion",
                "created": 0,
                "model": "answer-model-v1",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": json.dumps(
                                {"message": "Safe answer.", "citations": []}
                            ),
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 2,
                    "total_tokens": 12,
                },
            },
        )

    sync_client = openai.OpenAI(
        api_key="test",
        http_client=httpx.Client(transport=httpx.MockTransport(respond)),
        max_retries=0,
    )
    async_client = openai.AsyncOpenAI(
        api_key="test",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond)),
        max_retries=0,
    )
    client_options: dict[str, dict[str, object]] = {}

    def make_sync_client(**kwargs):
        client_options["sync"] = kwargs
        return sync_client

    def make_async_client(**kwargs):
        client_options["async"] = kwargs
        return async_client

    monkeypatch.setattr(openai, "OpenAI", make_sync_client)
    monkeypatch.setattr(openai, "AsyncOpenAI", make_async_client)

    class FakeSettings:
        openai_api_key = SecretStr("test")
        knowledge_index_name = "test-index"
        knowledge_release_id = "release-v1"
        customer_evidence_top_k = 3

        def __init__(self, **kwargs) -> None:
            del kwargs

    class FakeRetrievalService:
        def __init__(self, **kwargs) -> None:
            captured["embedding_provider"] = kwargs["embedding_provider"]

    class RecordingComposer:
        def __init__(self, model, *, capture_rejected_answer=False) -> None:
            del capture_rejected_answer
            captured["answer_model"] = model

    class FakeDependency:
        def __init__(self, *args, **kwargs) -> None:
            del args, kwargs

    monkeypatch.setattr("knowledge_rag.config.KnowledgeRetrievalSettings", FakeSettings)
    monkeypatch.setattr(
        "knowledge_rag.opensearch_local.create_local_opensearch_client", object
    )
    monkeypatch.setattr(
        "knowledge_rag.reranking.SentenceTransformersCrossEncoderProvider",
        FakeDependency,
    )
    monkeypatch.setattr(
        "knowledge_rag.retrieval_service.KnowledgeRetrievalService",
        FakeRetrievalService,
    )
    monkeypatch.setattr(
        "agent_runtime.refund.answer.LangChainRefundAnswerComposer",
        RecordingComposer,
    )

    config = make_config(tmp_path, allow_paid_api_calls=True)
    live_module.create_live_refund_answer_system(config, usage_recorder=recorder)
    assert client_options["sync"]["timeout"] == 30
    assert client_options["async"]["timeout"] == 30
    provider = captured["embedding_provider"]
    provider.embed_documents(["private query"])
    answer_model = captured["answer_model"]
    from agent_runtime.refund.answer import CustomerAnswer
    from langchain_core.messages import HumanMessage

    structured_model = answer_model.with_structured_output(
        CustomerAnswer,
        method="json_schema",
        strict=True,
    )
    answer = asyncio.run(
        structured_model.ainvoke([HumanMessage(content="private prompt")])
    )
    assert answer.message == "Safe answer."
    asyncio.run(async_client.close())
    sync_client.close()

    report = recorder.build_report(
        run_id=config.run_id,
        evaluation_version=config.evaluation_version,
        run_succeeded=True,
    )
    by_component = {item.component: item for item in report.components}
    assert by_component["query_embedding"].total_tokens == 4
    assert by_component["answer"].total_tokens == 12
    assert "private query" not in report.model_dump_json()
    assert "private prompt" not in report.model_dump_json()


def test_usage_writer_does_not_remove_unowned_staging_file(tmp_path: Path) -> None:
    output_path = tmp_path / "usage.json"
    staging_path = tmp_path / "usage.json.tmp"
    staging_path.write_text("belongs to another run")
    report = UsageRecorder().build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=False,
    )

    with pytest.raises(LiveRagEvaluationError, match="Could not write"):
        live_module._write_usage_report(output_path, report)

    assert staging_path.read_text() == "belongs to another run"
    assert not output_path.exists()


def test_usage_writer_does_not_overwrite_output_created_during_publish(
    monkeypatch,
    tmp_path: Path,
) -> None:
    output_path = tmp_path / "usage.json"
    report = UsageRecorder().build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=False,
    )

    def competing_publish(source, destination) -> None:
        del source
        Path(destination).write_text("belongs to another run")
        raise FileExistsError(destination)

    monkeypatch.setattr(live_module.os, "link", competing_publish)

    with pytest.raises(LiveRagEvaluationError, match="Could not write"):
        live_module._write_usage_report(output_path, report)

    assert output_path.read_text() == "belongs to another run"
    assert not (tmp_path / "usage.json.tmp").exists()


def test_live_run_supports_complete_dataset_and_uses_reviewed_metric_configuration(
    tmp_path: Path,
) -> None:
    system = FakeAnswerSystem()
    system_factory = RecordingFactory(system)
    scorer_factory = RecordingFactory(FakeRagasScorer())
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"selected_case_id": None}
    )

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=system_factory,
            scorer_factory=scorer_factory,
        )
    )

    assert [trial.case_id for trial in result.trials] == ["case-a", "case-b"]
    assert result.dataset_case_ids == ["case-a", "case-b"]
    assert [
        grade.grader_name
        for grade in result.trials[0].grader_results
        if grade.grader_name.startswith("ragas-")
    ] == ["ragas-faithfulness"]


def test_live_run_rejects_malformed_or_unknown_reviewed_metrics(
    tmp_path: Path,
) -> None:
    dataset_path = tmp_path / "dataset.json"
    config = make_config(tmp_path, allow_paid_api_calls=True)
    dataset_path.write_text(
        dataset_path.read_text().replace('"faithfulness"', '"made_up_metric"')
    )

    with pytest.raises(LiveRagEvaluationError, match="unsupported RAGAS metric"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=RecordingFactory(FakeAnswerSystem()),
                scorer_factory=RecordingFactory(FakeRagasScorer()),
            )
        )


def test_live_run_marks_reviewed_semantic_scores_blocking(tmp_path: Path) -> None:
    dataset_path = tmp_path / "dataset.json"
    config = make_config(tmp_path, allow_paid_api_calls=True)
    dataset_path.write_text(
        dataset_path.read_text().replace(
            '"semantic_scores_blocking": false', '"semantic_scores_blocking": true'
        )
    )
    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FakeAnswerSystem()),
            scorer_factory=RecordingFactory(FakeRagasScorer()),
        )
    )
    ragas_grades = [
        grade
        for grade in result.trials[0].grader_results
        if grade.grader_name.startswith("ragas-")
    ]
    assert ragas_grades and all(grade.blocking for grade in ragas_grades)


def test_live_run_selects_one_case_and_records_each_ragas_metric(
    tmp_path: Path,
) -> None:
    system = FakeAnswerSystem()
    system_factory = RecordingFactory(system)
    scorer_factory = RecordingFactory(FakeRagasScorer())
    config = make_config(tmp_path, allow_paid_api_calls=True)

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=system_factory,
            scorer_factory=scorer_factory,
        )
    )

    assert system.case_ids == ["case-b"]
    assert [trial.case_id for trial in result.trials] == ["case-b"]
    assert [grade.grader_name for grade in result.trials[0].grader_results] == [
        "answer-expected-evidence",
        "answer-minimum-citations",
        "answer-prohibited-claim",
        "ragas-faithfulness",
    ]
    grades = {grade.grader_name: grade for grade in result.trials[0].grader_results}
    assert grades["answer-prohibited-claim"].blocking is True
    assert all(
        not grade.blocking
        for name, grade in grades.items()
        if name.startswith("ragas-")
    )
    assert config.output_path.exists()
    assert "ragas-smoke-001" in config.output_path.read_text()
    assert system_factory.configs == [config]
    assert scorer_factory.configs == [config]


def test_live_run_persists_exact_judge_provenance_in_every_completed_sample(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"selected_case_id": None, "repetitions": 2}
    )

    asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FakeAnswerSystem()),
            scorer_factory=RecordingFactory(FakeRagasScorer()),
        )
    )

    persisted = EvaluationRun.model_validate_json(config.output_path.read_text())
    completed_samples = [
        trial.sample
        for trial in persisted.trials
        if trial.status is TrialStatus.COMPLETED
    ]
    assert len(completed_samples) == 4
    assert all(sample is not None for sample in completed_samples)
    assert all(
        sample.versions["judge_model"] == "judge-model-v1"
        and sample.versions["judge_embedding_model"] == "embedding-model-v1"
        and sample.versions["judge_max_tokens"] == "4096"
        for sample in completed_samples
        if sample is not None
    )


def test_live_run_rejects_unknown_case_before_constructing_clients(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"selected_case_id": "missing-case"}
    )
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="missing-case"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


def test_blocking_semantic_failure_is_recorded_as_failed_run(tmp_path: Path) -> None:
    dataset_path = tmp_path / "dataset.json"
    config = make_config(tmp_path, allow_paid_api_calls=True)
    dataset_path.write_text(
        dataset_path.read_text().replace(
            '"semantic_scores_blocking": false', '"semantic_scores_blocking": true'
        )
    )

    class LowScorer:
        async def score(self, metric, **inputs: object) -> float:
            return 0.1

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FakeAnswerSystem()),
            scorer_factory=RecordingFactory(LowScorer()),
        )
    )

    assert result.summary.pass_rate == 0
    assert result.trials[0].passed is False
    assert config.output_path.exists()


def test_system_error_is_recorded_as_failed_run(tmp_path: Path) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True)
    scorer = FakeRagasScorer()

    class FailingSystem:
        async def run(self, case, *, repetition: int):
            raise RuntimeError("system unavailable")

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FailingSystem()),
            scorer_factory=RecordingFactory(scorer),
        )
    )

    assert result.summary.pass_rate == 0
    assert result.trials[0].passed is False
    assert result.trials[0].status is TrialStatus.SYSTEM_ERROR
    assert scorer.calls == []

    persisted = EvaluationRun.model_validate_json(config.output_path.read_text())
    failed_trial = persisted.trials[0]
    assert failed_trial.status is TrialStatus.SYSTEM_ERROR
    assert failed_trial.sample is None
    assert failed_trial.grader_results == []
    assert failed_trial.error_message == "RuntimeError: system unavailable"


def test_system_error_writes_content_free_measured_usage_sidecar(
    tmp_path: Path,
) -> None:
    usage_path = tmp_path / "usage.json"
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"usage_output_path": usage_path}
    )
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.ANSWER,
        config.answer_model,
        {
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 3,
                "total_tokens": 15,
            },
            "response": "private response",
            "headers": {"authorization": "private secret"},
        },
    )

    class FailingSystem:
        async def run(self, case, *, repetition: int):
            raise RuntimeError("system unavailable")

    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=RecordingFactory(FailingSystem()),
            scorer_factory=RecordingFactory(FakeRagasScorer()),
            usage_recorder=recorder,
        )
    )

    assert result.trials[0].status is TrialStatus.SYSTEM_ERROR
    report = EvaluationUsageReport.model_validate_json(usage_path.read_text())
    assert report.run_status == "FAILED"
    assert report.measurement_status == "COMPLETE"
    assert report.total_tokens == 15
    serialized = usage_path.read_text()
    assert "private response" not in serialized
    assert "authorization" not in serialized
    assert "private secret" not in serialized


def test_usage_path_alias_is_rejected_before_constructing_clients(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True)
    config = config.model_copy(update={"usage_output_path": config.output_path})
    system_factory = RecordingFactory(FakeAnswerSystem())
    scorer_factory = RecordingFactory(FakeRagasScorer())

    with pytest.raises(LiveRagEvaluationError, match="usage output.*must not alias"):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=system_factory,
                scorer_factory=scorer_factory,
            )
        )

    assert system_factory.configs == []
    assert scorer_factory.configs == []


def test_scorer_failure_invalidates_live_run_without_persisting_quality_result(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True)

    class FailingScorer:
        async def score(self, metric, **inputs: object) -> float:
            raise RuntimeError("judge unavailable")

    with pytest.raises(
        LiveRagEvaluationError,
        match="Fatal evaluation error for case 'case-b'",
    ):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=RecordingFactory(FakeAnswerSystem()),
                scorer_factory=RecordingFactory(FailingScorer()),
            )
        )

    assert not config.output_path.exists()


def test_usage_write_failure_does_not_hide_fatal_evaluation_error(
    monkeypatch,
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, allow_paid_api_calls=True).model_copy(
        update={"usage_output_path": tmp_path / "usage.json"}
    )

    class FailingScorer:
        async def score(self, metric, **inputs: object) -> float:
            raise RuntimeError("judge unavailable")

    def fail_usage_write(*args, **kwargs) -> None:
        del args, kwargs
        raise LiveRagEvaluationError("usage write failed")

    monkeypatch.setattr(live_module, "_write_usage_report", fail_usage_write)

    with pytest.raises(
        LiveRagEvaluationError,
        match="Fatal evaluation error for case 'case-b'",
    ):
        asyncio.run(
            run_live_rag_evaluation(
                config,
                system_factory=RecordingFactory(FakeAnswerSystem()),
                scorer_factory=RecordingFactory(FailingScorer()),
            )
        )


def test_parse_args_omitted_case_id_means_full_dataset(tmp_path: Path) -> None:
    args = live_module.parse_args(
        [
            "--dataset-path",
            str(tmp_path / "dataset.json"),
            "--output-path",
            str(tmp_path / "result.json"),
            "--knowledge-env-path",
            str(tmp_path / "knowledge.env"),
            "--answer-model",
            "answer",
            "--judge-model",
            "judge",
            "--judge-embedding-model",
            "embedding",
            "--run-id",
            "run",
            "--evaluation-version",
            "version",
        ]
    )
    assert args.case_id is None


def test_parse_args_accepts_explicit_rejection_diagnostics_path(
    tmp_path: Path,
) -> None:
    diagnostics_path = tmp_path / "rejections.json"
    args = live_module.parse_args(
        [
            "--dataset-path",
            str(tmp_path / "dataset.json"),
            "--output-path",
            str(tmp_path / "result.json"),
            "--knowledge-env-path",
            str(tmp_path / "knowledge.env"),
            "--answer-model",
            "answer",
            "--judge-model",
            "judge",
            "--judge-embedding-model",
            "embedding",
            "--run-id",
            "run",
            "--evaluation-version",
            "version",
            "--rejection-diagnostics-path",
            str(diagnostics_path),
        ]
    )

    assert args.rejection_diagnostics_path == diagnostics_path


def test_main_exits_nonzero_for_failed_run(monkeypatch, tmp_path: Path) -> None:
    config_args = [
        "--dataset-path",
        str(tmp_path / "dataset.json"),
        "--output-path",
        str(tmp_path / "result.json"),
        "--knowledge-env-path",
        str(tmp_path / "knowledge.env"),
        "--answer-model",
        "answer",
        "--judge-model",
        "judge",
        "--judge-embedding-model",
        "embedding",
        "--run-id",
        "run",
        "--evaluation-version",
        "version",
    ]
    monkeypatch.setenv("ALLOW_PAID_API_CALLS", "true")
    monkeypatch.setattr(
        live_module, "run_live_rag_evaluation", lambda *args, **kwargs: None
    )
    monkeypatch.setattr(
        live_module.asyncio,
        "run",
        lambda coroutine: type(
            "FailedRun", (), {"summary": type("Summary", (), {"pass_rate": 0.0})()}
        )(),
    )

    with pytest.raises(SystemExit) as error:
        live_module.main(config_args)
    assert error.value.code == 1
