from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
from collections.abc import Callable, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Literal

from knowledge_rag.evaluation import EvidenceReference
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .answer_graders import (
    ExpectedAnswerEvidenceGrader,
    MinimumCitationCountGrader,
    ProhibitedClaimGrader,
)
from .models import (
    EvaluationCase,
    EvaluationDataset,
    EvaluationRun,
    EvaluationSample,
    RunSummary,
)
from .protocols import EvaluatedSystem
from .ragas_graders import (
    RagasGrader,
    RagasMetricName,
    RagasMetricScorer,
    create_ragas_collections_scorer,
)
from .runner import EvaluationRunError, run_evaluation
from .usage import (
    EvaluationUsageReport,
    PriceSchedule,
    UsageComponent,
    UsageRecorder,
    record_async_resource,
    record_sync_resource,
)


class LiveRagEvaluationError(RuntimeError):
    """Raised when a paid evaluation cannot be started or recorded safely."""


class LiveRagEvaluationConfig(BaseModel):
    """Explicit, bounded configuration for one paid RAGAS experiment."""

    model_config = ConfigDict(frozen=True)

    dataset_path: Path
    output_path: Path
    knowledge_env_path: Path
    selected_case_id: str | None = Field(default=None, min_length=1)
    answer_model: str = Field(min_length=1)
    judge_model: str = Field(min_length=1)
    judge_embedding_model: str = Field(min_length=1)
    run_id: str = Field(min_length=1)
    evaluation_version: str = Field(min_length=1)
    repetitions: int = Field(default=1, ge=1, le=5)
    semantic_minimum: float = Field(default=0.7, ge=0, le=1)
    allow_paid_api_calls: bool = False
    rejection_diagnostics_path: Path | None = None
    usage_output_path: Path | None = None
    price_schedule_path: Path | None = None


class SyntheticRejectedEvidence(BaseModel):
    """Content-free identity for evidence used by one rejected answer."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    rank: int = Field(gt=0)
    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    classification: Literal["CUSTOMER_SAFE"]


class SyntheticRejectionDiagnostic(BaseModel):
    """One rejected answer from the pinned reviewed synthetic dataset."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    trial_id: str = Field(min_length=1)
    case_id: str = Field(min_length=1)
    repetition: int = Field(gt=0)
    stage: Literal["ANSWER_COMPOSITION_POST_MODEL_VALIDATION"]
    rejection_code: str = Field(min_length=1)
    response: str = Field(min_length=1, max_length=2_000)
    response_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    citations: list[EvidenceReference] = Field(max_length=10)
    evidence: list[SyntheticRejectedEvidence] = Field(min_length=1)
    versions: dict[str, str] = Field(min_length=1)


class SyntheticRejectionDiagnosticSidecar(BaseModel):
    """Private diagnostics kept separate from evaluation quality evidence."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    run_id: str = Field(min_length=1)
    evaluation_version: str = Field(min_length=1)
    dataset_id: str = Field(min_length=1)
    dataset_version: str = Field(min_length=1)
    dataset_case_ids: list[str] = Field(min_length=1)
    rejections: list[SyntheticRejectionDiagnostic]


AnswerSystemFactory = Callable[[LiveRagEvaluationConfig], EvaluatedSystem]
RagasScorerFactory = Callable[[LiveRagEvaluationConfig], RagasMetricScorer]

# RAGAS defaults to 1024; reasoning judges need room to finish structured output.
_JUDGE_MAX_TOKENS = 4_096

_BUILT_IN_REVIEWED_SYNTHETIC_DATASET_SHA256_BY_PATH = {
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-rag-answer-v1.json": (
        "00aa539c014dfd3d45944c5f8bacc327e1c79dfdaf04b44027bd26a107f533d6"
    ),
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-rag-answer-v2.json": (
        "06679dfeb9e3279c29127233e6b694c3eb4a3c1583e334df3cfe4a37f1c7b7b3"
    ),
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-rag-answer-v3.json": (
        "1b128ab9db614854d5a76cc27c65966fb8fa234a2231664575f119af20b504de"
    ),
}


class _DiagnosticCaptureSystem:
    def __init__(
        self,
        *,
        system: EvaluatedSystem,
        run_id: str,
        rejections: list[SyntheticRejectionDiagnostic],
    ) -> None:
        self._system = system
        self._run_id = run_id
        self._rejections = rejections

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        try:
            return await self._system.run(case, repetition=repetition)
        except Exception as error:
            raw_diagnostic = getattr(error, "rejection_diagnostic", None)
            if raw_diagnostic is not None:
                from evaluation_runner.adapters.refund_rag_answer import (
                    RefundAnswerRejectionDiagnostic,
                    RefundRagAnswerExecutorError,
                )

                if not isinstance(
                    error, RefundRagAnswerExecutorError
                ) or not isinstance(raw_diagnostic, RefundAnswerRejectionDiagnostic):
                    raise
                diagnostic_data = raw_diagnostic.model_dump(mode="json")
                self._rejections.append(
                    SyntheticRejectionDiagnostic(
                        trial_id=f"{self._run_id}:{case.case_id}:{repetition}",
                        case_id=case.case_id,
                        repetition=repetition,
                        **diagnostic_data,
                    )
                )
            raise


class _VersionEvidenceSystem:
    def __init__(
        self,
        *,
        system: EvaluatedSystem,
        version_evidence: dict[str, str],
    ) -> None:
        self._system = system
        self._version_evidence = version_evidence

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        sample = await self._system.run(case, repetition=repetition)
        return sample.model_copy(
            update={
                "versions": {
                    **sample.versions,
                    **self._version_evidence,
                }
            }
        )


async def run_live_rag_evaluation(
    config: LiveRagEvaluationConfig,
    *,
    system_factory: AnswerSystemFactory,
    scorer_factory: RagasScorerFactory,
    usage_recorder: UsageRecorder | None = None,
) -> EvaluationRun:
    """Run an evaluation and persist a separate authoritative usage report."""
    price_schedule = _validate_usage_configuration(config)
    recorder = usage_recorder or UsageRecorder()
    try:
        result = await _run_live_rag_evaluation(
            config,
            system_factory=system_factory,
            scorer_factory=scorer_factory,
        )
    except Exception:
        if config.usage_output_path is not None:
            with suppress(Exception):
                _write_usage_report(
                    config.usage_output_path,
                    recorder.build_report(
                        run_id=config.run_id,
                        evaluation_version=config.evaluation_version,
                        run_succeeded=False,
                        price_schedule=price_schedule,
                    ),
                )
        raise

    if config.usage_output_path is not None:
        _write_usage_report(
            config.usage_output_path,
            recorder.build_report(
                run_id=config.run_id,
                evaluation_version=config.evaluation_version,
                run_succeeded=all(
                    trial.status.value == "COMPLETED" for trial in result.trials
                ),
                price_schedule=price_schedule,
            ),
        )
    return result


async def _run_live_rag_evaluation(
    config: LiveRagEvaluationConfig,
    *,
    system_factory: AnswerSystemFactory,
    scorer_factory: RagasScorerFactory,
) -> EvaluationRun:
    """Run one selected answer case or the complete dataset and persist evidence."""
    if not config.allow_paid_api_calls:
        raise LiveRagEvaluationError(
            "Set ALLOW_PAID_API_CALLS=true only after reviewing the run plan."
        )

    verified_dataset_json: bytes | None = None
    if config.rejection_diagnostics_path is not None:
        verified_dataset_json = _validate_synthetic_diagnostic_mode(config)

    dataset = _load_selected_dataset(config, dataset_json=verified_dataset_json)
    reviewed_configs = {
        case.case_id: _reviewed_ragas_configuration(case) for case in dataset.cases
    }
    try:
        underlying_system = system_factory(config)
        captured_rejections: list[SyntheticRejectionDiagnostic] = []
        if config.rejection_diagnostics_path is not None:
            underlying_system = _DiagnosticCaptureSystem(
                system=underlying_system,
                run_id=config.run_id,
                rejections=captured_rejections,
            )
        system = _VersionEvidenceSystem(
            system=underlying_system,
            version_evidence={
                "judge_model": config.judge_model,
                "judge_embedding_model": config.judge_embedding_model,
                "judge_max_tokens": str(_JUDGE_MAX_TOKENS),
            },
        )
        scorer = scorer_factory(config)
    except Exception as error:
        raise LiveRagEvaluationError(
            "Could not construct evaluation clients."
        ) from error

    # Run each reviewed case with exactly its configured semantic graders.
    case_runs: list[EvaluationRun] = []
    for case in dataset.cases:
        metrics, semantic_blocking = reviewed_configs[case.case_id]
        graders = [
            ExpectedAnswerEvidenceGrader(blocking=False),
            MinimumCitationCountGrader(blocking=False),
            ProhibitedClaimGrader(blocking=True),
            *[
                RagasGrader(
                    metric=metric,
                    scorer=scorer,
                    minimum=config.semantic_minimum,
                    blocking=semantic_blocking,
                )
                for metric in metrics
            ],
        ]
        try:
            case_runs.append(
                await run_evaluation(
                    dataset=dataset.model_copy(update={"cases": [case]}),
                    system=system,
                    graders=graders,
                    repetitions=config.repetitions,
                    run_id=config.run_id,
                    evaluation_version=config.evaluation_version,
                )
            )
        except EvaluationRunError as error:
            raise LiveRagEvaluationError(
                f"Fatal evaluation error for case {case.case_id!r}."
            ) from error

    trials = [trial for case_run in case_runs for trial in case_run.trials]
    case_summaries = [
        summary for case_run in case_runs for summary in case_run.case_summaries
    ]
    passed_trial_count = sum(trial.passed for trial in trials)
    consistent_case_count = sum(summary.all_trials_passed for summary in case_summaries)
    result = EvaluationRun(
        run_id=config.run_id,
        evaluation_version=config.evaluation_version,
        dataset_id=dataset.dataset_id,
        dataset_version=dataset.dataset_version,
        dataset_case_ids=[case.case_id for case in dataset.cases],
        repetitions=config.repetitions,
        trials=trials,
        case_summaries=case_summaries,
        summary=RunSummary(
            trial_count=len(trials),
            passed_trial_count=passed_trial_count,
            pass_rate=passed_trial_count / len(trials),
            case_count=len(case_summaries),
            consistent_case_count=consistent_case_count,
            consistent_case_rate=consistent_case_count / len(case_summaries),
        ),
    )
    if config.rejection_diagnostics_path is not None:
        _write_rejection_diagnostics(
            config.rejection_diagnostics_path,
            SyntheticRejectionDiagnosticSidecar(
                run_id=config.run_id,
                evaluation_version=config.evaluation_version,
                dataset_id=dataset.dataset_id,
                dataset_version=dataset.dataset_version,
                dataset_case_ids=[case.case_id for case in dataset.cases],
                rejections=captured_rejections,
            ),
        )
    _write_result(config.output_path, result)
    return result


def _validate_synthetic_diagnostic_mode(config: LiveRagEvaluationConfig) -> bytes:
    try:
        requested_dataset = config.dataset_path.resolve(strict=True)
        reviewed_datasets = {
            path.resolve(strict=True): digest
            for path, digest in (
                _BUILT_IN_REVIEWED_SYNTHETIC_DATASET_SHA256_BY_PATH.items()
            )
        }
    except OSError as error:
        raise LiveRagEvaluationError(
            "Could not validate the built-in reviewed synthetic dataset."
        ) from error
    expected_digest = reviewed_datasets.get(requested_dataset)
    if expected_digest is None:
        raise LiveRagEvaluationError(
            "Rejected-answer diagnostics require the built-in reviewed synthetic "
            "refund RAG dataset."
        )
    try:
        dataset_json = requested_dataset.read_bytes()
        dataset_digest = hashlib.sha256(dataset_json).hexdigest()
    except OSError as error:
        raise LiveRagEvaluationError(
            "Could not validate the built-in reviewed synthetic dataset."
        ) from error
    if dataset_digest != expected_digest:
        raise LiveRagEvaluationError(
            "The built-in synthetic dataset no longer matches its reviewed content pin."
        )

    diagnostics_path = config.rejection_diagnostics_path
    assert diagnostics_path is not None
    resolved_diagnostics_path = diagnostics_path.resolve(strict=False)
    resolved_result_path = config.output_path.resolve(strict=False)
    result_temporary_path = config.output_path.with_suffix(
        f"{config.output_path.suffix}.tmp"
    ).resolve(strict=False)
    if resolved_diagnostics_path in {resolved_result_path, result_temporary_path}:
        raise LiveRagEvaluationError(
            "The rejection diagnostics path must not alias the result or its "
            "temporary path."
        )
    if not diagnostics_path.parent.is_dir():
        raise LiveRagEvaluationError(
            f"Evaluation diagnostics directory {diagnostics_path.parent} does not exist."
        )
    if diagnostics_path.exists() or diagnostics_path.is_symlink():
        raise LiveRagEvaluationError(
            f"Evaluation diagnostics output {diagnostics_path} already exists."
        )
    if not config.output_path.parent.is_dir():
        raise LiveRagEvaluationError(
            f"Evaluation output directory {config.output_path.parent} does not exist."
        )
    if config.output_path.exists() or config.output_path.is_symlink():
        raise LiveRagEvaluationError(
            f"Evaluation result output {config.output_path} already exists."
        )
    result_staging_path = config.output_path.with_suffix(
        f"{config.output_path.suffix}.tmp"
    )
    if result_staging_path.exists() or result_staging_path.is_symlink():
        raise LiveRagEvaluationError(
            f"Evaluation result temporary output {result_staging_path} already exists."
        )
    return dataset_json


def _load_selected_dataset(
    config: LiveRagEvaluationConfig,
    *,
    dataset_json: str | bytes | None = None,
) -> EvaluationDataset:
    try:
        serialized_dataset = (
            dataset_json
            if dataset_json is not None
            else config.dataset_path.read_text()
        )
        dataset = EvaluationDataset.model_validate_json(serialized_dataset)
    except (OSError, ValidationError, ValueError) as error:
        raise LiveRagEvaluationError(
            f"Could not load evaluation dataset {config.dataset_path}."
        ) from error

    if config.selected_case_id is None:
        selected_cases = dataset.cases
    else:
        selected_cases = [
            case for case in dataset.cases if case.case_id == config.selected_case_id
        ]
    if not selected_cases:
        raise LiveRagEvaluationError(
            f"Evaluation case {config.selected_case_id!r} was not found."
        )

    return dataset.model_copy(update={"cases": selected_cases})


def _reviewed_ragas_configuration(case) -> tuple[tuple[RagasMetricName, ...], bool]:
    raw_metrics = case.expectations.get("ragas_metrics")
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise LiveRagEvaluationError(
            f"Case {case.case_id!r} has malformed ragas_metrics configuration."
        )
    metrics: list[RagasMetricName] = []
    for raw_metric in raw_metrics:
        if not isinstance(raw_metric, str):
            raise LiveRagEvaluationError(
                f"Case {case.case_id!r} has malformed ragas_metrics configuration."
            )
        try:
            metric = RagasMetricName(raw_metric)
        except ValueError as error:
            raise LiveRagEvaluationError(
                f"Case {case.case_id!r} has unsupported RAGAS metric {raw_metric!r}."
            ) from error
        if metric in metrics:
            raise LiveRagEvaluationError(
                f"Case {case.case_id!r} has duplicate RAGAS metric {raw_metric!r}."
            )
        metrics.append(metric)
    semantic_blocking = case.expectations.get("semantic_scores_blocking")
    if not isinstance(semantic_blocking, bool):
        raise LiveRagEvaluationError(
            f"Case {case.case_id!r} has malformed semantic_scores_blocking configuration."
        )
    return tuple(metrics), semantic_blocking


def _write_result(output_path: Path, result: EvaluationRun) -> None:
    if not output_path.parent.is_dir():
        raise LiveRagEvaluationError(
            f"Evaluation output directory {output_path.parent} does not exist."
        )

    temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    try:
        temporary_path.write_text(result.model_dump_json(indent=2))
        temporary_path.replace(output_path)
    except OSError as error:
        raise LiveRagEvaluationError(
            f"Could not write evaluation result to {output_path}."
        ) from error


def _write_rejection_diagnostics(
    output_path: Path,
    diagnostics: SyntheticRejectionDiagnosticSidecar,
) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor: int | None = None
    try:
        descriptor = os.open(output_path, flags, 0o600)
        with os.fdopen(descriptor, "w") as output_file:
            descriptor = None
            output_file.write(diagnostics.model_dump_json(indent=2))
            output_file.flush()
            os.fsync(output_file.fileno())
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        raise LiveRagEvaluationError(
            f"Could not write rejection diagnostics to {output_path}."
        ) from error


def _validate_usage_configuration(
    config: LiveRagEvaluationConfig,
) -> PriceSchedule | None:
    usage_path = config.usage_output_path
    if usage_path is None:
        if config.price_schedule_path is not None:
            raise LiveRagEvaluationError(
                "A price schedule requires an explicit usage output path."
            )
        return None

    usage_temporary = usage_path.with_suffix(f"{usage_path.suffix}.tmp")
    result_temporary = config.output_path.with_suffix(
        f"{config.output_path.suffix}.tmp"
    )
    protected = {
        config.output_path.resolve(strict=False),
        result_temporary.resolve(strict=False),
    }
    if config.rejection_diagnostics_path is not None:
        protected.add(config.rejection_diagnostics_path.resolve(strict=False))
    if (
        usage_path.resolve(strict=False) in protected
        or usage_temporary.resolve(strict=False) in protected
    ):
        raise LiveRagEvaluationError(
            "Evaluation usage output and staging paths must not alias result or "
            "rejection outputs."
        )
    for path, label in (
        (usage_path, "usage output"),
        (usage_temporary, "usage temporary output"),
        (config.output_path, "result output"),
        (result_temporary, "result temporary output"),
    ):
        if not path.parent.is_dir():
            raise LiveRagEvaluationError(
                f"Evaluation {label} directory {path.parent} does not exist."
            )
        if path.exists() or path.is_symlink():
            raise LiveRagEvaluationError(f"Evaluation {label} {path} already exists.")

    if config.price_schedule_path is None:
        return None
    try:
        return PriceSchedule.model_validate_json(config.price_schedule_path.read_text())
    except (OSError, ValidationError, ValueError) as error:
        raise LiveRagEvaluationError("Could not load the price schedule.") from error


def _write_usage_report(
    output_path: Path,
    report: EvaluationUsageReport,
) -> None:
    temporary_path = output_path.with_suffix(f"{output_path.suffix}.tmp")
    descriptor: int | None = None
    owns_temporary = False
    try:
        descriptor = os.open(
            temporary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
        )
        owns_temporary = True
        with os.fdopen(descriptor, "w") as output_file:
            descriptor = None
            output_file.write(report.model_dump_json(indent=2))
            output_file.flush()
            os.fsync(output_file.fileno())
        os.link(temporary_path, output_path)
        temporary_path.unlink()
        owns_temporary = False
    except OSError as error:
        if descriptor is not None:
            os.close(descriptor)
        if owns_temporary:
            try:
                temporary_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise LiveRagEvaluationError(
            f"Could not write evaluation usage report to {output_path}."
        ) from error


def create_live_refund_answer_system(
    config: LiveRagEvaluationConfig,
    *,
    usage_recorder: UsageRecorder | None = None,
) -> EvaluatedSystem:
    """Assemble the existing production RAG and answer components for evaluation."""
    try:
        from agent_runtime.config import RefundProposalSettings
        from agent_runtime.refund.proposal import RefundProposalBuilder
        from knowledge_rag.config import KnowledgeRetrievalSettings
        from knowledge_rag.embeddings import OpenAIEmbeddingProvider
        from knowledge_rag.opensearch_local import create_local_opensearch_client
        from knowledge_rag.reranking import (
            SentenceTransformersCrossEncoderProvider,
        )
        from knowledge_rag.retrieval_service import KnowledgeRetrievalService
        from langchain_openai import ChatOpenAI
        from openai import AsyncOpenAI, OpenAI

        from evaluation_runner.adapters.knowledge_answer import (
            KnowledgeAnswerEvaluatedSystem,
        )
        from evaluation_runner.adapters.refund_rag_answer import (
            RefundRagAnswerExecutor,
        )

        settings = KnowledgeRetrievalSettings(
            _env_file=config.knowledge_env_path,
        )
        api_key = settings.openai_api_key.get_secret_value()
        if usage_recorder is None:
            embedding_provider = OpenAIEmbeddingProvider(api_key=api_key)
            answer_client_options = {}
        else:
            usage_recorder.register(
                UsageComponent.QUERY_EMBEDDING, "text-embedding-3-small"
            )
            usage_recorder.register(UsageComponent.ANSWER, config.answer_model)
            sync_client = OpenAI(api_key=api_key, max_retries=0, timeout=30)
            async_client = AsyncOpenAI(api_key=api_key, max_retries=0, timeout=30)
            sync_client.embeddings = record_sync_resource(
                sync_client.embeddings,
                usage_recorder,
                UsageComponent.QUERY_EMBEDDING,
                "text-embedding-3-small",
            )
            sync_client.chat.completions = record_sync_resource(
                sync_client.chat.completions,
                usage_recorder,
                UsageComponent.ANSWER,
                config.answer_model,
            )
            async_client.chat.completions = record_async_resource(
                async_client.chat.completions,
                usage_recorder,
                UsageComponent.ANSWER,
                config.answer_model,
            )
            embedding_provider = OpenAIEmbeddingProvider(
                api_key=api_key,
                client=sync_client,
            )
            answer_client_options = {
                "client": sync_client.chat.completions,
                "async_client": async_client.chat.completions,
                "root_client": sync_client,
                "root_async_client": async_client,
            }
        retrieval_service = KnowledgeRetrievalService(
            client=create_local_opensearch_client(),
            index_name=settings.knowledge_index_name,
            embedding_provider=embedding_provider,
            reranking_provider=SentenceTransformersCrossEncoderProvider(),
        )
        answer_model = ChatOpenAI(
            model=config.answer_model,
            api_key=settings.openai_api_key,
            temperature=0,
            max_retries=0,
            timeout=30,
            **answer_client_options,
        )
        executor = RefundRagAnswerExecutor(
            retrieval_executor=retrieval_service,
            embedding_model=embedding_provider.model,
            answer_composer=_create_refund_answer_composer(answer_model, config),
            proposal_builder=RefundProposalBuilder(
                versions=RefundProposalSettings(
                    model_route_id=f"evaluation:{config.answer_model}",
                    knowledge_release_id=settings.knowledge_release_id,
                    evaluation_version=config.evaluation_version,
                ).to_versions()
            ),
            answer_model=config.answer_model,
            top_k=settings.customer_evidence_top_k,
        )
    except Exception as error:
        raise LiveRagEvaluationError(
            "Could not construct the live refund RAG answer system."
        ) from error

    return KnowledgeAnswerEvaluatedSystem(executor=executor)


def _create_refund_answer_composer(answer_model, config: LiveRagEvaluationConfig):
    from agent_runtime.refund.answer import LangChainRefundAnswerComposer

    return LangChainRefundAnswerComposer(
        answer_model,
        capture_rejected_answer=config.rejection_diagnostics_path is not None,
    )


def create_live_ragas_scorer(
    config: LiveRagEvaluationConfig,
    *,
    usage_recorder: UsageRecorder | None = None,
) -> RagasMetricScorer:
    """Construct explicit RAGAS judge clients only after paid calls are allowed."""
    try:
        from knowledge_rag.config import KnowledgeRetrievalSettings
        from openai import AsyncOpenAI
        from ragas.embeddings import OpenAIEmbeddings
        from ragas.llms import llm_factory

        settings = KnowledgeRetrievalSettings(
            _env_file=config.knowledge_env_path,
        )
        client = AsyncOpenAI(api_key=settings.openai_api_key.get_secret_value())
        if usage_recorder is not None:
            usage_recorder.register(UsageComponent.JUDGE, config.judge_model)
            usage_recorder.register(
                UsageComponent.JUDGE_EMBEDDING, config.judge_embedding_model
            )
            client.chat.completions = record_async_resource(
                client.chat.completions,
                usage_recorder,
                UsageComponent.JUDGE,
                config.judge_model,
            )
            client.embeddings = record_async_resource(
                client.embeddings,
                usage_recorder,
                UsageComponent.JUDGE_EMBEDDING,
                config.judge_embedding_model,
            )
        judge = llm_factory(
            config.judge_model,
            provider="openai",
            client=client,
            temperature=0,
            max_tokens=_JUDGE_MAX_TOKENS,
        )
        embeddings = OpenAIEmbeddings(
            client=client,
            model=config.judge_embedding_model,
        )
        return create_ragas_collections_scorer(
            llm=judge,
            embeddings=embeddings,
        )
    except Exception as error:
        raise LiveRagEvaluationError(
            "Could not construct the live RAGAS judge clients."
        ) from error


def parse_args(arguments: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one guarded live refund RAG answer evaluation case.",
    )
    parser.add_argument("--dataset-path", type=Path, required=True)
    parser.add_argument("--output-path", type=Path, required=True)
    parser.add_argument("--knowledge-env-path", type=Path, required=True)
    parser.add_argument("--case-id")
    parser.add_argument("--answer-model", required=True)
    parser.add_argument("--judge-model", required=True)
    parser.add_argument("--judge-embedding-model", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evaluation-version", required=True)
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--rejection-diagnostics-path", type=Path)
    parser.add_argument("--usage-output-path", type=Path)
    parser.add_argument("--price-schedule-path", type=Path)
    return parser.parse_args(arguments)


def main(arguments: Sequence[str] | None = None) -> None:
    args = parse_args(arguments)
    config = LiveRagEvaluationConfig(
        dataset_path=args.dataset_path,
        output_path=args.output_path,
        knowledge_env_path=args.knowledge_env_path,
        selected_case_id=args.case_id,
        answer_model=args.answer_model,
        judge_model=args.judge_model,
        judge_embedding_model=args.judge_embedding_model,
        run_id=args.run_id,
        evaluation_version=args.evaluation_version,
        repetitions=args.repetitions,
        rejection_diagnostics_path=args.rejection_diagnostics_path,
        usage_output_path=args.usage_output_path,
        price_schedule_path=args.price_schedule_path,
        allow_paid_api_calls=(
            os.environ.get("ALLOW_PAID_API_CALLS", "").lower() == "true"
        ),
    )
    usage_recorder = UsageRecorder() if config.usage_output_path is not None else None
    result = asyncio.run(
        run_live_rag_evaluation(
            config,
            system_factory=lambda live_config: create_live_refund_answer_system(
                live_config,
                usage_recorder=usage_recorder,
            ),
            scorer_factory=lambda live_config: create_live_ragas_scorer(
                live_config,
                usage_recorder=usage_recorder,
            ),
            usage_recorder=usage_recorder,
        )
    )
    if not result.summary.pass_rate == 1:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
