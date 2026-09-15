"""Offline integration regressions for the governed refund answer boundary."""

import asyncio

import pytest

pytest.importorskip("agent_runtime")

from agent_runtime.refund.answer import LangChainRefundAnswerComposer
from agent_runtime.refund.proposal import (
    RefundProposalBuilder,
    RefundProposalVersions,
)
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
    RefundRagAnswerExecutor,
    RefundRagAnswerExecutorError,
)
from evaluation_runner.answer_graders import MinimumCitationCountGrader
from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationDataset,
)
from evaluation_runner.runner import run_evaluation

DOC = "refund-policy-current-2026-08-01"


def request(message: str = "What does the policy say?") -> KnowledgeAnswerRequest:
    return KnowledgeAnswerRequest(
        case_id="answer-regression",
        user_input=message,
        tenant_id="tenant-local",
        environment_id="local",
        knowledge_release_id="refund-policy-2026-08-01",
        allowed_classifications=["CUSTOMER_SAFE"],
        locale="en-US",
        as_of="2026-08-12T12:00:00Z",
        system_context={
            "order_reference": "EVAL-REFUND-001",
            "item_name": "Evaluation item",
            "reason_code": "OTHER",
            "scope": "FULL_ORDER",
            "requested_amount_minor": 12000,
        },
    )


def proposal_builder() -> RefundProposalBuilder:
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


class FakeRetrieval:
    def __init__(self, content: str, chunk: str = "regression-chunk") -> None:
        self.content = content
        self.chunk = chunk

    def retrieve(self, request):
        evidence = RetrievedEvidence(
            index_document_id="knowledge-001",
            knowledge_document_id=DOC,
            chunk_id=self.chunk,
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
                section_path=["Refund policy"],
            ),
        )
        reranker = RerankerModel(provider="fake", model_name="fake", model_version="v1")
        return RetrievalExecutionResult(
            request=request,
            embedding_model=request.embedding_model,
            reranker_model=reranker,
            fused_candidate_count=1,
            evidence=[
                RerankedEvidence(
                    fused_evidence=FusedEvidence(
                        evidence=evidence,
                        reciprocal_rank_fusion_score=1.0,
                        contributing_retrievers=["semantic_vector"],
                    ),
                    reranker_score=1.0,
                    reranker_rank=1,
                    reranker_model=reranker,
                )
            ],
        )


class FakeAnswerModel:
    def __init__(self, message: str, chunk: str = "regression-chunk") -> None:
        self.message = message
        self.chunk = chunk

    def with_structured_output(self, *args, **kwargs):
        return self

    async def ainvoke(self, messages):
        return {
            "message": self.message,
            "citations": [{"knowledgeDocumentId": DOC, "chunkId": self.chunk}],
        }


def composer(message: str, *, capture: bool = True) -> LangChainRefundAnswerComposer:
    return LangChainRefundAnswerComposer(
        FakeAnswerModel(message), capture_rejected_answer=capture
    )


def executor(
    message: str, content: str, *, capture: bool = True
) -> RefundRagAnswerExecutor:
    return RefundRagAnswerExecutor(
        retrieval_executor=FakeRetrieval(content),
        embedding_model=EmbeddingModel(
            provider="fake", model_name="embed", model_version="v1", dimension=3
        ),
        answer_composer=composer(message, capture=capture),
        proposal_builder=proposal_builder(),
        answer_model="fake-answer",
    )


def test_exact_order_reference_with_colon_is_accepted() -> None:
    result = asyncio.run(
        executor(
            "For order EVAL-REFUND-001: the policy requires review.",
            "Review is required.",
        ).execute(request(), repetition=1)
    )
    assert "For order EVAL-REFUND-001:" in result.response


def test_wrong_order_reference_is_rejected_and_not_sampled() -> None:
    system = KnowledgeAnswerEvaluatedSystem(
        executor=executor(
            "For order OTHER-999: the policy requires review.", "Review is required."
        )
    )
    case = EvaluationCase(
        case_id="answer-regression",
        name="wrong reference",
        capability=EvaluationCapability.ANSWER,
        input=request().model_dump(mode="json", exclude={"case_id"}),
        expectations={"reference": "Review is required.", "minimum_citation_count": 0},
    )
    dataset = EvaluationDataset(dataset_id="d", dataset_version="v", cases=[case])
    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=system,
            graders=[MinimumCitationCountGrader()],
            repetitions=1,
            run_id="r",
            evaluation_version="v",
        )
    )
    assert run.trials[0].sample is None
    assert run.trials[0].status == "SYSTEM_ERROR"
    assert run.trials[0].grader_results == []


@pytest.mark.parametrize(
    "message",
    [
        "Since your request is final-sale, it does not meet standard refund eligibility. Not a final decision.",
        "The request does not meet standard refund eligibility. This is only a policy explanation.",
    ],
)
def test_personalized_eligibility_denial_with_disclaimer_is_rejected(
    message: str,
) -> None:
    with pytest.raises(RefundRagAnswerExecutorError) as raised:
        asyncio.run(
            executor(message, "Policy guidance.").execute(request(), repetition=1)
        )
    assert raised.value.rejection_diagnostic is not None
    assert (
        raised.value.rejection_diagnostic.rejection_code == "DELIVERY_AGE_TEXT_REJECTED"
    )


def test_cited_delivery_window_preserves_incorrect_or_missing_scope() -> None:
    content = "Incorrect or missing items may be requested within 30 calendar days of delivery."
    accepted = (
        "Incorrect item requests are allowed within 30 calendar days of delivery."
    )
    result = asyncio.run(executor(accepted, content).execute(request(), repetition=1))
    assert "According to the published policy," in result.response
    assert "within 30 calendar days of delivery" in result.response
    assert "Your delivery timing has not been verified." in result.response
    assert result.evidence[0].content == content
    assert result.citations[0].chunk_id == "regression-chunk"


@pytest.mark.parametrize(
    "message",
    [
        "The published policy allows incorrect item requests within 30 calendar days of delivery.",
        "The published policy allows incorrect or missing item requests within 45 calendar days of delivery.",
        "The published policy allows incorrect or missing item requests within 30 calendar days of delivery.",
    ],
)
def test_delivery_window_rejects_narrowed_unsupported_or_incomplete_claims(
    message: str,
) -> None:
    content = "Incorrect or missing items may be requested within 30 calendar days of delivery and while unopened."
    with pytest.raises(RefundRagAnswerExecutorError) as raised:
        asyncio.run(executor(message, content).execute(request(), repetition=1))
    assert raised.value.rejection_diagnostic is not None
    assert (
        raised.value.rejection_diagnostic.rejection_code == "DELIVERY_AGE_TEXT_REJECTED"
    )
