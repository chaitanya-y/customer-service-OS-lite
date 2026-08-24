from datetime import UTC, datetime

import pytest
from pydantic import SecretStr

from agent_runtime import config as runtime_config
from agent_runtime.integrations.customer_evidence import CustomerEvidence
from agent_runtime.integrations.order_lookup import OrderContext
from agent_runtime.refund.answer import (
    LangChainRefundAnswerComposer,
    RefundAnswerCompositionError,
    build_fallback_customer_answer,
)
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import (
    RefundProposalBuilder,
    RefundProposalVersions,
)


class FakeStructuredModel:
    def __init__(self, result: object) -> None:
        self.result = result
        self.messages = []

    async def ainvoke(self, messages):
        self.messages = messages
        return self.result


class FakeChatModel:
    def __init__(self, structured_model: FakeStructuredModel) -> None:
        self.structured_model = structured_model

    def with_structured_output(self, *args, **kwargs):
        del args, kwargs
        return self.structured_model


def make_proposal(order_context: OrderContext):
    identifiers = iter(["proposal-1", "execution-1"])
    builder = RefundProposalBuilder(
        versions=RefundProposalVersions(
            agent_release_id="agent-runtime-test",
            prompt_bundle_version="refund-intent-v1",
            model_route_id="refund-intent-test-model",
            knowledge_release_id="refund-policy-2026-08-01",
            guardrail_version="refund-proposal-guardrails-v1",
            evaluation_version="evaluation-test-v1",
            order_lookup_tool_version="lookup-order-v1",
        ),
        create_id=lambda: next(identifiers),
        now=lambda: datetime(2026, 8, 14, 12, 0, tzinfo=UTC),
    )
    return builder.build(
        extraction=RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        ),
        order_context=order_context,
        turn_id="turn-1",
        trace_id="trace-1",
    )


def make_evidence() -> CustomerEvidence:
    return CustomerEvidence.model_validate(
        {
            "knowledge_document_id": "refund-policy-current-2026-08-01",
            "chunk_id": "section-003-chunk-001",
            "content": "Damaged items may be refunded.",
            "citation": {
                "source_uri": "s3://cso-knowledge/tenant-local/refund-policy-2026-08-01.md",
                "title": "Refund Policy",
                "section_path": ["Refund eligibility"],
            },
            "retrieval_methods": ["semantic_vector"],
            "reranker_rank": 1,
        }
    )


@pytest.mark.asyncio
async def test_answer_composer_accepts_a_citation_from_retrieved_evidence(
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {
            "message": "Damaged items may be eligible for a refund review.",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    composer = LangChainRefundAnswerComposer(FakeChatModel(structured_model))  # type: ignore[arg-type]

    answer = await composer.compose(
        customer_message="My item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        knowledge_evidence=[make_evidence()],
    )

    assert answer.citations[0].chunk_id == "section-003-chunk-001"
    assert len(structured_model.messages) == 2


@pytest.mark.asyncio
async def test_answer_composer_rejects_a_citation_not_in_retrieved_evidence(
    order_context: OrderContext,
) -> None:
    composer = LangChainRefundAnswerComposer(
        FakeChatModel(
            FakeStructuredModel(
                {
                    "message": "This is unsupported.",
                    "citations": [
                        {
                            "knowledgeDocumentId": "internal-playbook",
                            "chunkId": "section-001-chunk-001",
                        }
                    ],
                }
            )
        )  # type: ignore[arg-type]
    )

    with pytest.raises(RefundAnswerCompositionError):
        await composer.compose(
            customer_message="My item arrived damaged.",
            refund_proposal=make_proposal(order_context),
            knowledge_evidence=[make_evidence()],
        )


def test_fallback_answer_does_not_claim_a_refund_decision(
    order_context: OrderContext,
) -> None:
    fallback = build_fallback_customer_answer(make_proposal(order_context))

    assert fallback.citations == []
    assert "approved" not in fallback.message.lower()
    assert "denied" not in fallback.message.lower()


@pytest.mark.asyncio
async def test_configured_answer_composer_uses_a_single_bounded_attempt(
    monkeypatch: pytest.MonkeyPatch,
    order_context: OrderContext,
) -> None:
    structured_model = FakeStructuredModel(
        {
            "message": "Please share photos of the damaged item.",
            "citations": [
                {
                    "knowledgeDocumentId": "refund-policy-current-2026-08-01",
                    "chunkId": "section-003-chunk-001",
                }
            ],
        }
    )
    captured_options: dict[str, object] = {}

    class FakeSettings:
        refund_answer_model = "test-answer-model"
        openai_api_key = SecretStr("test-api-key")
        refund_answer_model_timeout_seconds = 30.0

    class FakeConfiguredChatModel:
        def __init__(self, **kwargs: object) -> None:
            captured_options.update(kwargs)

        def with_structured_output(self, *args: object, **kwargs: object):
            del args, kwargs
            return structured_model

    monkeypatch.setattr(runtime_config, "RefundAnswerModelSettings", FakeSettings)
    monkeypatch.setattr(runtime_config, "ChatOpenAI", FakeConfiguredChatModel)

    composer = runtime_config.ConfiguredRefundAnswerComposer()
    answer = await composer.compose(
        customer_message="My item arrived damaged.",
        refund_proposal=make_proposal(order_context),
        knowledge_evidence=[make_evidence()],
    )

    assert answer.citations[0].chunk_id == "section-003-chunk-001"
    assert captured_options["model"] == "test-answer-model"
    assert captured_options["max_retries"] == 0
    assert captured_options["timeout"] == 30.0
