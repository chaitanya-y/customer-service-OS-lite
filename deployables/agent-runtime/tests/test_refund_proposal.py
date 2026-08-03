import json
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

from agent_runtime.integrations.order_lookup import OrderContext
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import (
    RefundProposal,
    RefundProposalBuilder,
    RefundProposalVersions,
)

TEST_NOW = datetime(2026, 8, 2, 12, 0, tzinfo=UTC)
TEST_VERSIONS = RefundProposalVersions(
    agent_release_id="agent-runtime-test",
    prompt_bundle_version="refund-intent-v1",
    model_route_id="refund-intent-test-model",
    knowledge_release_id="knowledge-not-used",
    guardrail_version="refund-proposal-guardrails-v1",
    evaluation_version="refund-proposal-eval-v1",
    order_lookup_tool_version="lookup-order-v1",
)


def create_builder() -> RefundProposalBuilder:
    identifiers = iter(["proposal-1", "execution-1"])
    return RefundProposalBuilder(
        versions=TEST_VERSIONS,
        create_id=lambda: next(identifiers),
        now=lambda: TEST_NOW,
    )


def build_proposal(
    extraction: RefundIntentExtraction,
    order_context: OrderContext,
) -> RefundProposal:
    return create_builder().build(
        extraction=extraction,
        order_context=order_context,
        turn_id="turn-1",
        trace_id="trace-1",
    )


def test_builds_a_complete_full_order_proposal(
    order_context: OrderContext,
) -> None:
    proposal = build_proposal(
        RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        ),
        order_context,
    )

    assert proposal.proposal_id == "proposal-1"
    assert proposal.intent.order_id == "3"
    assert proposal.intent.scope == "FULL_ORDER"
    assert proposal.intent.item_ids == []
    assert proposal.missing_fields == []
    assert proposal.evidence_ids == ["observation-1"]
    assert proposal.execution_evidence.execution_id == "execution-1"
    assert proposal.execution_evidence.evidence_refs[0].content_digest == (
        f"sha256:{'a' * 64}"
    )


def test_records_missing_reason_and_scope(
    order_context: OrderContext,
) -> None:
    proposal = build_proposal(
        RefundIntentExtraction(
            reason_code="UNSPECIFIED",
            scope="UNSPECIFIED",
            selected_item_ids=[],
        ),
        order_context,
    )

    assert proposal.missing_fields == ["REFUND_REASON", "REFUND_SCOPE"]
    assert proposal.intent.reason_code == "UNSPECIFIED"
    assert proposal.intent.scope == "UNSPECIFIED"


def test_accepts_item_ids_that_exist_in_the_order(
    order_context: OrderContext,
) -> None:
    proposal = build_proposal(
        RefundIntentExtraction(
            reason_code="WRONG_ITEM",
            scope="SELECTED_ITEMS",
            selected_item_ids=["item-1"],
        ),
        order_context,
    )

    assert proposal.intent.scope == "SELECTED_ITEMS"
    assert proposal.intent.item_ids == ["item-1"]
    assert proposal.missing_fields == []


def test_does_not_silently_accept_an_invented_item_id(
    order_context: OrderContext,
) -> None:
    proposal = build_proposal(
        RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="SELECTED_ITEMS",
            selected_item_ids=["item-1", "invented-item"],
        ),
        order_context,
    )

    assert proposal.intent.scope == "UNSPECIFIED"
    assert proposal.intent.item_ids == []
    assert proposal.missing_fields == ["ITEM_SELECTION"]


def test_generated_proposal_matches_the_canonical_json_schema(
    order_context: OrderContext,
) -> None:
    proposal = build_proposal(
        RefundIntentExtraction(
            reason_code="DAMAGED",
            scope="FULL_ORDER",
            selected_item_ids=[],
        ),
        order_context,
    )
    repository_root = Path(__file__).resolve().parents[3]
    proposal_schema = json.loads(
        (
            repository_root
            / "contracts/workflows/proposals/v1/refund-proposal.schema.json"
        ).read_text()
    )
    evidence_schema = json.loads(
        (
            repository_root
            / "contracts/ai-io/execution-evidence/v1/execution-evidence.schema.json"
        ).read_text()
    )
    registry = Registry().with_resource(
        evidence_schema["$id"],
        Resource.from_contents(evidence_schema),
    )
    validator = Draft202012Validator(
        proposal_schema,
        registry=registry,
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )

    validator.validate(
        proposal.model_dump(
            by_alias=True,
            mode="json",
            exclude_none=True,
        )
    )
