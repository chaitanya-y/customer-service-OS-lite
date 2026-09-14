import asyncio

import pytest

pytest.importorskip("agent_runtime")

from agent_runtime.refund.answer import (
    CustomerAnswer,
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
    RefundAnswerRejectionCode,
)
from agent_runtime.refund.proposal import RefundProposalBuilder, RefundProposalVersions
from knowledge_rag.embeddings import EmbeddingModel
from knowledge_rag.hybrid_retrieval import FusedEvidence
from knowledge_rag.reranking import RerankedEvidence, RerankerModel
from knowledge_rag.retrieval_results import EvidenceCitation, RetrievedEvidence
from knowledge_rag.retrieval_service import RetrievalExecutionResult

from evaluation_runner.adapters.knowledge_answer import (
    KnowledgeAnswerEvaluatedSystem,
    KnowledgeAnswerRequest,
)
from evaluation_runner.adapters.refund_rag_answer import (
    RefundAnswerRejectionDiagnostic,
    RefundRagAnswerExecutor,
    RefundRagAnswerExecutorError,
)
from evaluation_runner.models import EvaluationCapability, EvaluationCase
from evaluation_runner.ragas_graders import RagasGrader, RagasMetricName


def make_request() -> KnowledgeAnswerRequest:
    return KnowledgeAnswerRequest(
        case_id="damaged-item-evidence-answer-v1",
        user_input="My item arrived damaged. What do I need?",
        tenant_id="tenant-local",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=["CUSTOMER_SAFE"],
        locale="en-US",
        as_of="2026-08-12T12:00:00Z",
        system_context={
            "order_reference": "EVAL-REFUND-001",
            "item_name": "Evaluation item",
            "reason_code": "DAMAGED",
            "scope": "FULL_ORDER",
            "requested_amount_minor": 12000,
        },
    )


class RecordingRetrievalExecutor:
    def __init__(
        self, content: str = "Photo evidence is required before approval."
    ) -> None:
        self.requests = []
        self.content = content

    def retrieve(self, request) -> RetrievalExecutionResult:
        self.requests.append(request)
        evidence = RetrievedEvidence(
            index_document_id="knowledge-001",
            knowledge_document_id="refund-policy-current-2026-08-01",
            chunk_id="section-003-chunk-001",
            content=self.content,
            content_sha256="a" * 64,
            retrieval_score=1.0,
            knowledge_release_id=request.knowledge_release_id,
            tenant_id=request.tenant_id,
            environment_id=request.environment_id,
            classification="CUSTOMER_SAFE",
            locale=request.locale,
            citation=EvidenceCitation(
                source_uri="s3://cso-knowledge/refund-policy.md",
                title="Refund policy",
                section_path=["Refund eligibility", "Damaged items"],
            ),
        )
        reranker_model = RerankerModel(
            provider="fake",
            model_name="fake-reranker",
            model_version="v1",
        )
        return RetrievalExecutionResult(
            request=request,
            embedding_model=request.embedding_model,
            reranker_model=reranker_model,
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
                    reranker_model=reranker_model,
                )
            ],
        )


class RecordingAnswerComposer:
    def __init__(self, message="Please provide a clear photo before review.") -> None:
        self.calls = []
        self.message = message

    async def compose(self, **kwargs) -> CustomerAnswer:
        self.calls.append(kwargs)
        return CustomerAnswer(
            message=self.message,
            citations=[
                {
                    "knowledge_document_id": "refund-policy-current-2026-08-01",
                    "chunk_id": "section-003-chunk-001",
                }
            ],
        )


class RejectingAnswerComposer:
    def __init__(
        self,
        rejected_answer: CustomerAnswer | None = None,
        reason_code: RefundAnswerRejectionCode = (
            RefundAnswerRejectionCode.MODEL_OUTPUT_INVALID
        ),
    ) -> None:
        self.rejected_answer = rejected_answer
        self.reason_code = reason_code

    async def compose(self, **kwargs) -> CustomerAnswer:
        del kwargs
        raise RefundAnswerCompositionError(
            self.reason_code,
            rejected_answer=self.rejected_answer,
        )


class FixedAnswerModel:
    """Replace only the external model, leaving the production composer intact."""

    def with_structured_output(self, *args, **kwargs):
        return self

    async def ainvoke(self, messages):
        return {
            "message": (
                "The published policy allows damaged-item refund requests "
                "within 30 calendar days of delivery."
            ),
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }


def test_executor_preserves_qualified_policy_and_unmodified_evidence() -> None:
    content = (
        "Customers may request a refund for an item that arrived damaged within "
        "30 calendar days of delivery. Photo evidence is required before approval."
    )
    executor = RefundRagAnswerExecutor(
        retrieval_executor=RecordingRetrievalExecutor(content),
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=LangChainRefundAnswerComposer(FixedAnswerModel()),  # type: ignore[arg-type]
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )

    result = asyncio.run(executor.execute(make_request(), repetition=1))

    assert "within 30 calendar days of delivery" in result.response
    assert (
        "This is policy information, not confirmation that your request qualifies. "
        "Your delivery timing has not been verified."
    ) in result.response
    assert "USD 120.00" in result.response
    assert result.evidence[0].content == content
    assert result.citations[0].chunk_id == "section-003-chunk-001"


def make_proposal_builder() -> RefundProposalBuilder:
    return RefundProposalBuilder(
        versions=RefundProposalVersions(
            agent_release_id="agent-runtime-evaluation",
            prompt_bundle_version="refund-answer-v4",
            model_route_id="refund-answer-evaluation",
            knowledge_release_id="refund-policy-2026-08-01",
            guardrail_version="refund-answer-guardrails-v1",
            evaluation_version="ragas-evaluation-v1",
            order_lookup_tool_version="synthetic-order-context-v1",
        ),
        create_id=lambda: "evaluation-id",
    )


def test_refund_rag_executor_reuses_retrieval_and_production_answer_contracts() -> None:
    retrieval_executor = RecordingRetrievalExecutor()
    answer_composer = RecordingAnswerComposer()
    embedding_model = EmbeddingModel(
        provider="fake",
        model_name="fake-embedding",
        model_version="v1",
        dimension=3,
    )
    executor = RefundRagAnswerExecutor(
        retrieval_executor=retrieval_executor,
        embedding_model=embedding_model,
        answer_composer=answer_composer,
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
        top_k=3,
    )

    result = asyncio.run(executor.execute(make_request(), repetition=2))

    retrieval_request = retrieval_executor.requests[0]
    assert retrieval_request.query_text == "My item arrived damaged. What do I need?"
    assert retrieval_request.allowed_classifications == ["CUSTOMER_SAFE"]
    assert retrieval_request.as_of.isoformat() == "2026-08-12T12:00:00+00:00"
    assert retrieval_request.top_k == 3

    composer_call = answer_composer.calls[0]
    assert composer_call["order_context"].reference == "EVAL-REFUND-001"
    assert composer_call["order_context"].items[0].name == "Evaluation item"
    assert composer_call["refund_proposal"].intent.reason_code == "DAMAGED"
    assert (
        composer_call["refund_proposal"].intent.requested_amount.amount_minor == 12000
    )
    assert composer_call["knowledge_evidence"][0].content == (
        "Photo evidence is required before approval."
    )

    assert result.response == "Please provide a clear photo before review."
    assert result.evidence[0].content_sha256 == "a" * 64
    assert result.citations[0].chunk_id == "section-003-chunk-001"
    assert result.versions == {
        "application_facts": "synthetic-refund-facts-v1",
        "answer_model": "fake-answer-model",
        "answer_prompt": "refund-answer-v8",
        "embedding_model": "fake:fake-embedding:v1:3",
        "knowledge_release": "refund-policy-2026-08-01",
        "reranker_model": "fake:fake-reranker:v1",
    }


def test_refund_rag_executor_rejects_invalid_synthetic_context() -> None:
    request = make_request().model_copy(
        update={
            "system_context": {
                **make_request().system_context,
                "requested_amount_minor": 0,
            }
        }
    )
    executor = RefundRagAnswerExecutor(
        retrieval_executor=RecordingRetrievalExecutor(),
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=RecordingAnswerComposer(),
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )

    with pytest.raises(RefundRagAnswerExecutorError, match="system context"):
        asyncio.run(executor.execute(request, repetition=1))


def test_refund_rag_executor_reports_only_safe_answer_rejection_code() -> None:
    executor = RefundRagAnswerExecutor(
        retrieval_executor=RecordingRetrievalExecutor(),
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=RejectingAnswerComposer(),
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )

    with pytest.raises(
        RefundRagAnswerExecutorError,
        match=r"Customer answer rejected: MODEL_OUTPUT_INVALID\.$",
    ) as raised:
        asyncio.run(executor.execute(make_request(), repetition=1))

    assert raised.value.rejection_diagnostic is None


def test_refund_rag_executor_attaches_privacy_safe_rejected_answer_diagnostic() -> None:
    rejected_answer = CustomerAnswer(
        message="Your USD 120.00 refund is approved.",
        citations=[
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
            }
        ],
    )
    executor = RefundRagAnswerExecutor(
        retrieval_executor=RecordingRetrievalExecutor(),
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=RejectingAnswerComposer(
            rejected_answer,
            RefundAnswerRejectionCode.MONEY_TEXT_REJECTED,
        ),
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )

    with pytest.raises(RefundRagAnswerExecutorError) as raised:
        asyncio.run(executor.execute(make_request(), repetition=2))

    diagnostic = raised.value.rejection_diagnostic
    assert isinstance(diagnostic, RefundAnswerRejectionDiagnostic)
    assert diagnostic.model_dump(mode="json") == {
        "stage": "ANSWER_COMPOSITION_POST_MODEL_VALIDATION",
        "rejection_code": "MONEY_TEXT_REJECTED",
        "response": "Your USD 120.00 refund is approved.",
        "response_sha256": (
            "6f5ab8e7e2ad0afacebb89e15162ba7055854028b11846e81532bd2cb2fcc7a8"
        ),
        "citations": [
            {
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
            }
        ],
        "evidence": [
            {
                "rank": 1,
                "knowledge_document_id": "refund-policy-current-2026-08-01",
                "chunk_id": "section-003-chunk-001",
                "content_sha256": "a" * 64,
                "classification": "CUSTOMER_SAFE",
            }
        ],
        "versions": {
            "application_facts": "synthetic-refund-facts-v1",
            "answer_model": "fake-answer-model",
            "answer_prompt": "refund-answer-v8",
            "embedding_model": "fake:fake-embedding:v1:3",
            "knowledge_release": "refund-policy-2026-08-01",
            "reranker_model": "fake:fake-reranker:v1",
        },
    }
    assert "Photo evidence" not in diagnostic.model_dump_json()


@pytest.mark.parametrize(
    ("field", "unsafe_value"),
    [
        ("classification", "INTERNAL"),
        ("tenant_id", "another-tenant"),
        ("environment_id", "production"),
        ("knowledge_release_id", "another-release"),
        ("locale", "fr-FR"),
    ],
)
def test_refund_rag_executor_rejects_unsafe_evidence_before_composition(
    field: str,
    unsafe_value: str,
) -> None:
    retrieval = RecordingRetrievalExecutor()
    original_retrieve = retrieval.retrieve

    def retrieve_with_unsafe_evidence(request):
        result = original_retrieve(request)
        ranked = result.evidence[0]
        evidence = ranked.fused_evidence.evidence.model_copy(
            update={field: unsafe_value}
        )
        return result.model_copy(
            update={
                "evidence": [
                    ranked.model_copy(
                        update={
                            "fused_evidence": ranked.fused_evidence.model_copy(
                                update={"evidence": evidence}
                            )
                        }
                    )
                ]
            }
        )

    retrieval.retrieve = retrieve_with_unsafe_evidence  # type: ignore[method-assign]
    composer = RecordingAnswerComposer()
    executor = RefundRagAnswerExecutor(
        retrieval_executor=retrieval,
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=composer,
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )

    with pytest.raises(RefundRagAnswerExecutorError, match="trusted answer context"):
        asyncio.run(executor.execute(make_request(), repetition=1))

    assert composer.calls == []


@pytest.mark.parametrize(
    ("amount_minor", "formatted_amount"), [(12000, "120.00"), (123456, "1,234.56")]
)
def test_refund_evaluation_grounds_in_fixture_not_generated_answer(
    amount_minor, formatted_amount
) -> None:
    request = make_request()
    request.system_context["requested_amount_minor"] = amount_minor
    composer = RecordingAnswerComposer("Your USD 999.00 refund is approved.")
    executor = RefundRagAnswerExecutor(
        retrieval_executor=RecordingRetrievalExecutor(),
        embedding_model=EmbeddingModel(
            provider="fake",
            model_name="fake-embedding",
            model_version="v1",
            dimension=3,
        ),
        answer_composer=composer,
        proposal_builder=make_proposal_builder(),
        answer_model="fake-answer-model",
    )
    case = EvaluationCase(
        case_id=request.case_id,
        name="Independent refund facts",
        capability=EvaluationCapability.ANSWER,
        input=request.model_dump(mode="json", exclude={"case_id"}),
        expectations={"reference": "Damage photos are required before review."},
        tags=["rag"],
    )
    system = KnowledgeAnswerEvaluatedSystem(executor=executor)
    sample = asyncio.run(system.run(case, repetition=1))

    facts = sample.output.get("application_facts", [])
    assert f"Proposed refund amount: USD {formatted_amount}." in facts
    assert "Customer delivery timing has not been verified." in facts
    assert "No refund has been approved or executed in this evaluation." in facts
    assert "999.00" not in " ".join(facts)
    assert sample.output["response"] == "Your USD 999.00 refund is approved."
    assert sample.output["retrieved_contexts"] == [
        "Photo evidence is required before approval."
    ]
    assert "reference" not in composer.calls[0]

    class RecordingJudge:
        async def score(self, metric, **inputs):
            self.inputs = inputs
            return 0.0

    judge = RecordingJudge()
    grade = asyncio.run(
        RagasGrader(
            metric=RagasMetricName.FAITHFULNESS, scorer=judge, minimum=0.8
        ).grade(case, sample)
    )
    grounding = " ".join(judge.inputs["retrieved_contexts"])
    assert f"USD {formatted_amount}" in grounding
    assert "999.00" not in grounding
    assert "No refund has been approved" in grounding
    assert grade.passed is False
