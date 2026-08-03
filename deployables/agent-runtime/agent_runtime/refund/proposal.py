from collections.abc import Callable
from datetime import UTC, datetime
from typing import Literal
from uuid import uuid4

from pydantic import AwareDatetime, Field, field_validator, model_validator

from agent_runtime.integrations.order_lookup import (
    ContractModel,
    Money,
    OpaqueId,
    OrderContext,
)
from agent_runtime.refund.intent import RefundIntentExtraction

MissingField = Literal[
    "ORDER_REFERENCE",
    "REFUND_REASON",
    "REFUND_SCOPE",
    "ITEM_SELECTION",
]
ProposalScope = Literal["FULL_ORDER", "SELECTED_ITEMS", "UNSPECIFIED"]


class RefundIntent(ContractModel):
    order_id: OpaqueId
    reason_code: str = Field(min_length=1, max_length=120)
    scope: ProposalScope
    item_ids: list[OpaqueId] = Field(max_length=100)
    requested_amount: Money | None = None

    @field_validator("item_ids")
    @classmethod
    def item_ids_must_be_unique(cls, item_ids: list[str]) -> list[str]:
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("item_ids must be unique")

        return item_ids

    @model_validator(mode="after")
    def scope_must_match_item_selection(self) -> "RefundIntent":
        if self.scope == "SELECTED_ITEMS" and not self.item_ids:
            raise ValueError("SELECTED_ITEMS requires item_ids")

        if self.scope == "FULL_ORDER" and self.item_ids:
            raise ValueError("FULL_ORDER does not accept item_ids")

        return self


class EvidenceReference(ContractModel):
    evidence_id: OpaqueId
    evidence_type: Literal[
        "BUSINESS_FACT",
        "KNOWLEDGE_CITATION",
        "POLICY_DECISION",
        "TOOL_OBSERVATION",
        "HUMAN_DECISION",
    ]
    source_version: str = Field(min_length=1, max_length=160)
    content_digest: str | None = Field(
        default=None,
        pattern=r"^sha256:[a-f0-9]{64}$",
    )


class ToolContractVersion(ContractModel):
    tool_id: OpaqueId
    version: str = Field(min_length=1, max_length=160)


class DependencyVersions(ContractModel):
    agent_release_id: str = Field(min_length=1, max_length=160)
    workflow_build_id: str | None = Field(default=None, min_length=1, max_length=160)
    prompt_bundle_version: str = Field(min_length=1, max_length=160)
    model_route_id: str = Field(min_length=1, max_length=160)
    knowledge_release_id: str = Field(min_length=1, max_length=160)
    guardrail_version: str = Field(min_length=1, max_length=160)
    evaluation_version: str = Field(min_length=1, max_length=160)
    tool_contracts: list[ToolContractVersion]


class ExecutionEvidence(ContractModel):
    schema_version: Literal["1"] = "1"
    execution_id: OpaqueId
    scope: Literal["TURN", "ACTION"]
    recorded_at: AwareDatetime
    trace_id: OpaqueId
    dependencies: DependencyVersions
    evidence_refs: list[EvidenceReference]


class RefundProposal(ContractModel):
    schema_version: Literal["1"] = "1"
    result_type: Literal["JOURNEY_PROPOSAL"] = "JOURNEY_PROPOSAL"
    proposal_id: OpaqueId
    journey_type: Literal["REFUND"] = "REFUND"
    turn_id: OpaqueId
    intent: RefundIntent
    missing_fields: list[MissingField]
    evidence_ids: list[OpaqueId] = Field(min_length=1)
    execution_evidence: ExecutionEvidence

    @field_validator("missing_fields", "evidence_ids")
    @classmethod
    def values_must_be_unique(cls, values: list[str]) -> list[str]:
        if len(values) != len(set(values)):
            raise ValueError("values must be unique")

        return values


class RefundProposalVersions(ContractModel):
    agent_release_id: str = Field(min_length=1, max_length=160)
    prompt_bundle_version: str = Field(min_length=1, max_length=160)
    model_route_id: str = Field(min_length=1, max_length=160)
    knowledge_release_id: str = Field(min_length=1, max_length=160)
    guardrail_version: str = Field(min_length=1, max_length=160)
    evaluation_version: str = Field(min_length=1, max_length=160)
    order_lookup_tool_version: str = Field(min_length=1, max_length=160)


class RefundProposalBuilder:
    def __init__(
        self,
        *,
        versions: RefundProposalVersions,
        create_id: Callable[[], str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        self._versions = versions
        self._create_id = create_id or (lambda: str(uuid4()))
        self._now = now or (lambda: datetime.now(UTC))

    def build(
        self,
        *,
        extraction: RefundIntentExtraction,
        order_context: OrderContext,
        turn_id: str,
        trace_id: str,
    ) -> RefundProposal:
        intent, missing_fields = self._build_intent(extraction, order_context)
        evidence_id = order_context.observation_id

        return RefundProposal(
            proposal_id=self._create_id(),
            turn_id=turn_id,
            intent=intent,
            missing_fields=missing_fields,
            evidence_ids=[evidence_id],
            execution_evidence=ExecutionEvidence(
                execution_id=self._create_id(),
                scope="TURN",
                recorded_at=self._now(),
                trace_id=trace_id,
                dependencies=DependencyVersions(
                    agent_release_id=self._versions.agent_release_id,
                    prompt_bundle_version=self._versions.prompt_bundle_version,
                    model_route_id=self._versions.model_route_id,
                    knowledge_release_id=self._versions.knowledge_release_id,
                    guardrail_version=self._versions.guardrail_version,
                    evaluation_version=self._versions.evaluation_version,
                    tool_contracts=[
                        ToolContractVersion(
                            tool_id="lookup_order",
                            version=self._versions.order_lookup_tool_version,
                        )
                    ],
                ),
                evidence_refs=[
                    EvidenceReference(
                        evidence_id=evidence_id,
                        evidence_type="TOOL_OBSERVATION",
                        source_version=order_context.schema_version,
                        content_digest=order_context.source.facts_version,
                    )
                ],
            ),
        )

    @staticmethod
    def _build_intent(
        extraction: RefundIntentExtraction,
        order_context: OrderContext,
    ) -> tuple[RefundIntent, list[MissingField]]:
        missing_fields: list[MissingField] = []

        if extraction.reason_code == "UNSPECIFIED":
            missing_fields.append("REFUND_REASON")

        scope: ProposalScope = extraction.scope
        item_ids: list[str] = []

        if extraction.scope == "UNSPECIFIED":
            missing_fields.append("REFUND_SCOPE")
        elif extraction.scope == "SELECTED_ITEMS":
            available_item_ids = {item.item_id for item in order_context.items}
            selected_item_ids = extraction.selected_item_ids

            if not selected_item_ids or any(
                item_id not in available_item_ids for item_id in selected_item_ids
            ):
                scope = "UNSPECIFIED"
                missing_fields.append("ITEM_SELECTION")
            else:
                item_ids = selected_item_ids

        return (
            RefundIntent(
                order_id=order_context.source.order_id,
                reason_code=extraction.reason_code,
                scope=scope,
                item_ids=item_ids,
            ),
            missing_fields,
        )
