from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from time import perf_counter
from typing import Protocol

from knowledge_rag.evaluation import EvidenceReference
from knowledge_rag.ingestion import KnowledgeDocumentClassification
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    ValidationError,
    model_validator,
)

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)


class KnowledgeAnswerAdapterError(RuntimeError):
    """Raised when answer-evaluation data crosses a trust boundary."""


class KnowledgeAnswerRequest(BaseModel):
    """The input visible to the system under evaluation, without answer keys."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    case_id: str = Field(min_length=1)
    user_input: str = Field(min_length=1)
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    allowed_classifications: list[KnowledgeDocumentClassification] = Field(min_length=1)
    locale: str = Field(min_length=1)
    as_of: datetime
    system_context: dict[str, JsonValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_customer_answer_scope(self) -> KnowledgeAnswerRequest:
        if self.allowed_classifications != [
            KnowledgeDocumentClassification.CUSTOMER_SAFE
        ]:
            raise ValueError(
                "Knowledge answer evaluation permits only CUSTOMER_SAFE context."
            )
        if self.as_of.tzinfo is None or self.as_of.utcoffset() is None:
            raise ValueError("as_of must include a timezone")
        return self


class KnowledgeAnswerEvidence(BaseModel):
    """One ordered customer-safe chunk supplied to the answer composer."""

    model_config = ConfigDict(frozen=True)

    knowledge_document_id: str = Field(min_length=1)
    chunk_id: str = Field(min_length=1)
    content: str = Field(min_length=1)
    content_sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")
    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    knowledge_release_id: str = Field(min_length=1)
    classification: KnowledgeDocumentClassification
    locale: str = Field(min_length=1)

    @property
    def key(self) -> tuple[str, str]:
        return (self.knowledge_document_id, self.chunk_id)


class KnowledgeAnswerExecutionResult(BaseModel):
    """Answer and evidence observed from one execution of the RAG boundary."""

    model_config = ConfigDict(frozen=True)

    response: str = Field(min_length=1)
    evidence: list[KnowledgeAnswerEvidence] = Field(min_length=1)
    # Only the trusted executor may supply these, never generated answer text.
    application_facts: list[str] = Field(default_factory=list)
    citations: list[EvidenceReference] = Field(default_factory=list)
    versions: dict[str, str] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_evidence_and_versions(self) -> KnowledgeAnswerExecutionResult:
        if any(not fact.strip() for fact in self.application_facts):
            raise ValueError("Application facts must not be blank.")
        evidence_keys = [item.key for item in self.evidence]
        if len(evidence_keys) != len(set(evidence_keys)):
            raise ValueError("Answer evidence must have unique document-scoped IDs.")

        citation_keys = [item.key for item in self.citations]
        if len(citation_keys) != len(set(citation_keys)):
            raise ValueError("Answer citations must be unique.")

        if any(
            not key.strip() or not value.strip() for key, value in self.versions.items()
        ):
            raise ValueError("Answer execution versions must not be blank.")
        return self


class KnowledgeAnswerExecutor(Protocol):
    """Execute one answer case without receiving its reviewed reference answer."""

    async def execute(
        self,
        request: KnowledgeAnswerRequest,
        *,
        repetition: int,
    ) -> KnowledgeAnswerExecutionResult:
        """Return the response and exact customer-safe evidence used."""


class KnowledgeAnswerEvaluatedSystem:
    """Convert a governed RAG answer execution into an evaluation sample."""

    adapter_version = "knowledge-answer-adapter-v2"

    def __init__(
        self,
        *,
        executor: KnowledgeAnswerExecutor,
        clock: Callable[[], float] = perf_counter,
    ) -> None:
        self._executor = executor
        self._clock = clock

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        if case.capability is not EvaluationCapability.ANSWER:
            raise KnowledgeAnswerAdapterError(
                "Knowledge answer evaluation requires an ANSWER evaluation case."
            )

        try:
            request = KnowledgeAnswerRequest(
                case_id=case.case_id,
                **case.input,
            )
        except (TypeError, ValidationError) as error:
            raise KnowledgeAnswerAdapterError(
                f"Invalid knowledge answer case input: {error}"
            ) from error

        started_at = self._clock()
        result = KnowledgeAnswerExecutionResult.model_validate(
            await self._executor.execute(request, repetition=repetition)
        )
        elapsed_ms = (self._clock() - started_at) * 1_000
        if elapsed_ms < 0:
            raise KnowledgeAnswerAdapterError(
                "The monotonic evaluation clock moved backwards."
            )

        _validate_evidence_context(request=request, result=result)
        _validate_citations(result)

        return EvaluationSample(
            output={
                "response": result.response,
                "application_facts": list(result.application_facts),
                "retrieved_contexts": [item.content for item in result.evidence],
                "retrieved_evidence": [
                    {
                        "rank": rank,
                        "knowledge_document_id": item.knowledge_document_id,
                        "chunk_id": item.chunk_id,
                        "content_sha256": item.content_sha256,
                        "classification": item.classification.value,
                    }
                    for rank, item in enumerate(result.evidence, start=1)
                ],
                "citations": [
                    citation.model_dump(mode="json") for citation in result.citations
                ],
            },
            final_state={"answer_completed": True},
            trace=[
                TraceEvent(
                    sequence=rank,
                    kind=TraceEventKind.RETRIEVAL,
                    name="knowledge_chunk_used_for_answer",
                    payload={
                        "rank": rank,
                        "knowledge_document_id": item.knowledge_document_id,
                        "chunk_id": item.chunk_id,
                        "content_sha256": item.content_sha256,
                        "classification": item.classification.value,
                    },
                )
                for rank, item in enumerate(result.evidence, start=1)
            ],
            latency_ms=elapsed_ms,
            versions={**result.versions, "adapter": self.adapter_version},
        )


def _validate_evidence_context(
    *,
    request: KnowledgeAnswerRequest,
    result: KnowledgeAnswerExecutionResult,
) -> None:
    for item in result.evidence:
        if item.classification is not KnowledgeDocumentClassification.CUSTOMER_SAFE:
            raise KnowledgeAnswerAdapterError(
                "Knowledge answer evidence must be CUSTOMER_SAFE."
            )
        if (
            item.tenant_id != request.tenant_id
            or item.environment_id != request.environment_id
            or item.knowledge_release_id != request.knowledge_release_id
            or item.locale != request.locale
        ):
            raise KnowledgeAnswerAdapterError(
                "Knowledge answer evidence is outside the trusted answer context."
            )


def _validate_citations(result: KnowledgeAnswerExecutionResult) -> None:
    retrieved_keys = {item.key for item in result.evidence}
    if any(citation.key not in retrieved_keys for citation in result.citations):
        raise KnowledgeAnswerAdapterError(
            "Customer answer citation was not retrieved for this execution."
        )
