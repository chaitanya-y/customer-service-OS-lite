import asyncio

import pytest

from evaluation_runner.adapters.knowledge_answer import (
    KnowledgeAnswerAdapterError,
    KnowledgeAnswerEvaluatedSystem,
    KnowledgeAnswerEvidence,
    KnowledgeAnswerExecutionResult,
)
from evaluation_runner.models import EvaluationCapability, EvaluationCase


def make_case() -> EvaluationCase:
    return EvaluationCase(
        case_id="damaged-item-answer-v1",
        name="Damaged item answer",
        capability=EvaluationCapability.ANSWER,
        input={
            "user_input": "What do I need for a damaged-item refund?",
            "tenant_id": "acme",
            "environment_id": "local",
            "knowledge_release_id": "refund-policy-2026-08-01",
            "allowed_classifications": ["CUSTOMER_SAFE"],
            "locale": "en-US",
            "as_of": "2026-08-12T12:00:00Z",
            "system_context": {
                "order_reference": "EVAL-ORDER-001",
                "item_name": "Evaluation item",
            },
        },
        expectations={
            "reference": (
                "Provide clear damage photos. The order and affected item must "
                "be verified before review."
            )
        },
        tags=["rag", "answer", "damaged-item"],
    )


def make_evidence(
    *,
    tenant_id: str = "acme",
    classification: str = "CUSTOMER_SAFE",
) -> KnowledgeAnswerEvidence:
    return KnowledgeAnswerEvidence(
        knowledge_document_id="refund-policy-current-2026-08-01",
        chunk_id="section-003-chunk-001",
        content="Damage photos are required before a damaged-item review.",
        content_sha256="a" * 64,
        tenant_id=tenant_id,
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        classification=classification,
        locale="en-US",
    )


def make_result(
    *,
    evidence: list[KnowledgeAnswerEvidence] | None = None,
    citations: list[dict[str, str]] | None = None,
) -> KnowledgeAnswerExecutionResult:
    return KnowledgeAnswerExecutionResult(
        response=(
            "Please provide clear photos of the damage so the order and item "
            "can be reviewed."
        ),
        evidence=evidence or [make_evidence()],
        citations=citations
        or [
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
            }
        ],
        versions={
            "answer_prompt": "refund-answer-v3",
            "knowledge_release": "refund-policy-2026-08-01",
        },
    )


class RecordingExecutor:
    def __init__(self, result: KnowledgeAnswerExecutionResult) -> None:
        self.result = result
        self.calls = []

    async def execute(self, request, *, repetition: int):
        self.calls.append((request, repetition))
        return self.result


def test_answer_adapter_passes_only_input_to_executor_and_builds_sample() -> None:
    executor = RecordingExecutor(make_result())
    ticks = iter([10.0, 10.025])
    system = KnowledgeAnswerEvaluatedSystem(
        executor=executor,
        clock=lambda: next(ticks),
    )

    sample = asyncio.run(system.run(make_case(), repetition=2))

    request, repetition = executor.calls[0]
    assert repetition == 2
    assert request.model_dump(mode="json") == {
        "case_id": "damaged-item-answer-v1",
        "user_input": "What do I need for a damaged-item refund?",
        "tenant_id": "acme",
        "environment_id": "local",
        "knowledge_release_id": "refund-policy-2026-08-01",
        "allowed_classifications": ["CUSTOMER_SAFE"],
        "locale": "en-US",
        "as_of": "2026-08-12T12:00:00Z",
        "system_context": {
            "order_reference": "EVAL-ORDER-001",
            "item_name": "Evaluation item",
        },
    }
    assert "reference" not in request.model_dump(mode="json")
    assert sample.output == {
        "application_facts": [],
        "response": (
            "Please provide clear photos of the damage so the order and item "
            "can be reviewed."
        ),
        "retrieved_contexts": [
            "Damage photos are required before a damaged-item review."
        ],
        "retrieved_evidence": [
            {
                "rank": 1,
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
                "content_sha256": "a" * 64,
                "classification": "CUSTOMER_SAFE",
            }
        ],
        "citations": [
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
            }
        ],
    }
    assert sample.final_state == {"answer_completed": True}
    assert sample.latency_ms == pytest.approx(25.0)
    assert sample.versions == {
        "adapter": "knowledge-answer-adapter-v2",
        "answer_prompt": "refund-answer-v3",
        "knowledge_release": "refund-policy-2026-08-01",
    }
    assert [event.payload["rank"] for event in sample.trace] == [1]
    assert "content" not in sample.trace[0].payload


@pytest.mark.parametrize(
    ("case", "message"),
    [
        (
            make_case().model_copy(
                update={"capability": EvaluationCapability.RETRIEVAL}
            ),
            "ANSWER evaluation case",
        ),
        (
            make_case().model_copy(
                update={
                    "input": {
                        **make_case().input,
                        "allowed_classifications": ["CUSTOMER_SAFE", "INTERNAL"],
                    }
                }
            ),
            "only CUSTOMER_SAFE",
        ),
    ],
)
def test_answer_adapter_rejects_invalid_case_scope(
    case: EvaluationCase,
    message: str,
) -> None:
    system = KnowledgeAnswerEvaluatedSystem(executor=RecordingExecutor(make_result()))

    with pytest.raises(KnowledgeAnswerAdapterError, match=message):
        asyncio.run(system.run(case, repetition=1))


@pytest.mark.parametrize(
    ("evidence", "message"),
    [
        (make_evidence(classification="INTERNAL"), "CUSTOMER_SAFE"),
        (make_evidence(tenant_id="another-tenant"), "trusted answer context"),
    ],
)
def test_answer_adapter_rejects_unsafe_or_cross_context_evidence(
    evidence: KnowledgeAnswerEvidence,
    message: str,
) -> None:
    result = make_result(evidence=[evidence], citations=[])
    system = KnowledgeAnswerEvaluatedSystem(executor=RecordingExecutor(result))

    with pytest.raises(KnowledgeAnswerAdapterError, match=message):
        asyncio.run(system.run(make_case(), repetition=1))


def test_answer_adapter_rejects_citation_that_was_not_retrieved() -> None:
    result = make_result(
        citations=[
            {
                "knowledge_document_id": "invented-document",
                "chunk_id": "invented-chunk",
            }
        ]
    )
    system = KnowledgeAnswerEvaluatedSystem(executor=RecordingExecutor(result))

    with pytest.raises(KnowledgeAnswerAdapterError, match="citation was not retrieved"):
        asyncio.run(system.run(make_case(), repetition=1))


def test_answer_adapter_keeps_facts_separate_from_retrieved_evidence() -> None:
    result = make_result().model_copy(
        update={"application_facts": ["Proposed refund amount: USD 120.00."]}
    )
    system = KnowledgeAnswerEvaluatedSystem(executor=RecordingExecutor(result))

    sample = asyncio.run(system.run(make_case(), repetition=1))

    assert sample.output.get("application_facts") == [
        "Proposed refund amount: USD 120.00."
    ]
    assert sample.output["retrieved_contexts"] == [
        "Damage photos are required before a damaged-item review."
    ]
    assert len(sample.output["retrieved_evidence"]) == 1
    assert len(sample.trace) == 1


@pytest.mark.parametrize("facts", [[""], ["   "], [7]])
def test_answer_execution_rejects_invalid_application_facts(facts) -> None:
    data = make_result().model_dump()
    data["application_facts"] = facts

    with pytest.raises(ValueError):
        KnowledgeAnswerExecutionResult.model_validate(data)
