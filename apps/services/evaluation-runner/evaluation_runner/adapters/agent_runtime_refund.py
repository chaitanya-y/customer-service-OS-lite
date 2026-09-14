from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime
from hashlib import sha256
from itertools import count
from time import perf_counter
from typing import Any, Literal

from agent_runtime.integrations.customer_evidence import (
    CustomerEvidence,
    CustomerEvidenceCitation,
    CustomerEvidenceLookupUnavailableError,
    CustomerEvidenceResponse,
)
from agent_runtime.integrations.order_lookup import (
    CustomerRef,
    Money,
    OrderContext,
    OrderItem,
    OrderLookupUnavailableError,
    OrderNotFoundError,
    OrderSource,
)
from agent_runtime.refund.answer import CustomerAnswer
from agent_runtime.refund.conversation import ConversationCustomerMessage
from agent_runtime.refund.graph import build_refund_graph
from agent_runtime.refund.intent import RefundIntentExtraction
from agent_runtime.refund.proposal import RefundProposalBuilder, RefundProposalVersions
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationCase,
    EvaluationSample,
    TraceEvent,
    TraceEventKind,
)


class AgentRuntimeRefundAdapterError(RuntimeError):
    """Raised when an agent-evaluation case is not deterministic or reviewable."""


class SyntheticOrder(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    reference: str = Field(min_length=1, max_length=100)
    order_id: str = Field(min_length=1, max_length=160)
    observation_id: str = Field(min_length=1, max_length=160)
    amount_minor: int = Field(gt=0)


class OrderLookupConfiguration(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    outcome: Literal["success", "not_found", "unavailable"]


class RefundAgentTurn(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    customer_message: str = Field(min_length=1, max_length=2_000)
    order_reference: str | None = Field(default=None, min_length=1, max_length=100)
    previous_order_reference: str | None = Field(
        default=None,
        min_length=1,
        max_length=100,
    )
    conversation_messages: list[ConversationCustomerMessage] = Field(
        default_factory=list,
        max_length=8,
    )

    @field_validator("customer_message", "order_reference", "previous_order_reference")
    @classmethod
    def reject_whitespace_only_strings(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("value must not be whitespace-only")
        return value

    @model_validator(mode="after")
    def validate_history(self) -> RefundAgentTurn:
        if not self.conversation_messages:
            return self
        if self.conversation_messages[-1].text != self.customer_message:
            raise ValueError("conversation history must end with customer_message")
        sequence_numbers = [
            message.sequence_number for message in self.conversation_messages
        ]
        if sequence_numbers != sorted(sequence_numbers) or len(sequence_numbers) != len(
            set(sequence_numbers)
        ):
            raise ValueError(
                "conversation history must have increasing sequence numbers"
            )
        return self


class RefundAgentCaseInput(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    tenant_id: str = Field(min_length=1)
    environment_id: str = Field(min_length=1)
    customer_message: str | None = Field(default=None, min_length=1, max_length=2_000)
    order_reference: str | None = Field(default=None, min_length=1, max_length=100)
    conversation_messages: list[ConversationCustomerMessage] = Field(
        default_factory=list,
        max_length=8,
    )
    turns: list[RefundAgentTurn] = Field(default_factory=list, max_length=8)
    order_lookup: OrderLookupConfiguration
    synthetic_order: SyntheticOrder | None = None
    intent: RefundIntentExtraction = Field(
        default_factory=lambda: RefundIntentExtraction(
            reason_code="UNSPECIFIED",
            scope="UNSPECIFIED",
            selected_item_ids=[],
        )
    )
    customer_evidence_outcome: Literal["available", "unavailable"] = "available"

    @field_validator(
        "tenant_id",
        "environment_id",
        "customer_message",
        "order_reference",
    )
    @classmethod
    def reject_whitespace_only_strings(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("value must not be whitespace-only")
        return value

    @model_validator(mode="after")
    def validate_execution_shape(self) -> RefundAgentCaseInput:
        has_single_turn = self.customer_message is not None
        if has_single_turn == bool(self.turns):
            raise ValueError("provide exactly one single-turn input or turns")
        if self.turns and (
            self.customer_message is not None
            or self.order_reference is not None
            or self.conversation_messages
        ):
            raise ValueError("multi-turn input must not mix top-level turn fields")
        if self.conversation_messages and (
            self.conversation_messages[-1].text != self.customer_message
        ):
            raise ValueError("conversation history must end with customer_message")
        requires_order_lookup = any(
            turn.order_reference or turn.previous_order_reference
            for turn in self.execution_turns()
        )
        if (
            self.order_lookup.outcome == "success"
            and requires_order_lookup
            and self.synthetic_order is None
        ):
            raise ValueError("successful order lookup requires a synthetic_order")
        return self

    def execution_turns(self) -> list[RefundAgentTurn]:
        if self.turns:
            return self.turns
        assert self.customer_message is not None
        return [
            RefundAgentTurn(
                customer_message=self.customer_message,
                order_reference=self.order_reference,
                conversation_messages=self.conversation_messages,
            )
        ]


class _TraceRecorder:
    def __init__(self) -> None:
        self.events: list[TraceEvent] = []

    def record(
        self,
        kind: TraceEventKind,
        name: str,
        payload: dict[str, Any],
    ) -> None:
        self.events.append(
            TraceEvent(
                sequence=len(self.events) + 1,
                kind=kind,
                name=name,
                payload=_to_json(payload),
            )
        )


class _DeterministicOrderLookup:
    def __init__(
        self,
        *,
        configuration: OrderLookupConfiguration,
        order_context: OrderContext | None,
        tenant_id: str,
        environment_id: str,
        recorder: _TraceRecorder,
    ) -> None:
        self._configuration = configuration
        self._order_context = order_context
        self._tenant_id = tenant_id
        self._environment_id = environment_id
        self._recorder = recorder

    async def lookup_order(self, order_reference: str) -> OrderContext:
        self._recorder.record(
            TraceEventKind.TOOL_CALL,
            "lookup_order",
            {
                "arguments": {"order_reference": order_reference},
                "trusted_context": {
                    "tenant_id": self._tenant_id,
                    "environment_id": self._environment_id,
                    "source": "evaluation_fixture",
                },
                "outcome": self._configuration.outcome,
            },
        )
        if self._configuration.outcome == "not_found":
            raise OrderNotFoundError()
        if self._configuration.outcome == "unavailable":
            raise OrderLookupUnavailableError()
        assert self._order_context is not None
        return self._order_context


class _DeterministicIntentExtractor:
    def __init__(
        self, *, intent: RefundIntentExtraction, recorder: _TraceRecorder
    ) -> None:
        self._intent = intent
        self._recorder = recorder

    async def extract(
        self,
        *,
        customer_message: str,
        conversation_messages: list[ConversationCustomerMessage],
        order_context: OrderContext,
    ) -> RefundIntentExtraction:
        self._recorder.record(
            TraceEventKind.MODEL_CALL,
            "extract_refund_intent",
            {
                "customer_message": customer_message,
                "conversation_messages": [
                    message.model_dump(mode="json") for message in conversation_messages
                ],
                "order_reference": order_context.reference,
            },
        )
        return self._intent


class _DeterministicCustomerEvidenceLookup:
    def __init__(
        self,
        *,
        outcome: Literal["available", "unavailable"],
        recorder: _TraceRecorder,
    ) -> None:
        self._outcome = outcome
        self._recorder = recorder

    async def retrieve_customer_evidence(
        self,
        query_text: str,
    ) -> CustomerEvidenceResponse:
        self._recorder.record(
            TraceEventKind.RETRIEVAL,
            "retrieve_customer_evidence",
            {"query_text": query_text, "outcome": self._outcome},
        )
        if self._outcome == "unavailable":
            raise CustomerEvidenceLookupUnavailableError()
        return CustomerEvidenceResponse(
            knowledge_release_id="evaluation-refund-policy-v1",
            evidence=[
                CustomerEvidence(
                    knowledge_document_id="evaluation-refund-policy",
                    chunk_id="evaluation-refund-policy-chunk",
                    content="Synthetic customer-safe evaluation evidence.",
                    citation=CustomerEvidenceCitation(
                        source_uri="evaluation://refund-policy",
                        title="Synthetic refund policy",
                        section_path=["Evaluation"],
                    ),
                    retrieval_methods=["deterministic"],
                    reranker_rank=1,
                )
            ],
        )


class _DeterministicAnswerComposer:
    def __init__(self, *, recorder: _TraceRecorder) -> None:
        self._recorder = recorder

    async def compose(self, **kwargs: Any) -> CustomerAnswer:
        self._recorder.record(
            TraceEventKind.MODEL_CALL,
            "compose_customer_answer",
            {
                "order_reference": kwargs["order_context"].reference,
                "evidence_count": len(kwargs["knowledge_evidence"]),
            },
        )
        return CustomerAnswer(
            message="Your refund request has been recorded. It is not approved.",
            citations=[],
        )


class AgentRuntimeRefundEvaluatedSystem:
    """Run the production refund graph with synthetic deterministic dependencies."""

    adapter_version = "agent-runtime-refund-adapter-v1"

    def __init__(self, *, clock: Callable[[], float] = perf_counter) -> None:
        self._clock = clock

    async def run(
        self,
        case: EvaluationCase,
        *,
        repetition: int,
    ) -> EvaluationSample:
        if case.capability is not EvaluationCapability.AGENT:
            raise AgentRuntimeRefundAdapterError(
                "Refund trajectory evaluation requires an AGENT evaluation case."
            )
        try:
            request = RefundAgentCaseInput.model_validate(case.input)
        except ValidationError as error:
            raise AgentRuntimeRefundAdapterError(
                f"Invalid deterministic refund-agent input: {error}"
            ) from error

        recorder = _TraceRecorder()
        order_context = (
            _build_synthetic_order_context(request.synthetic_order)
            if request.synthetic_order is not None
            else None
        )
        graph = build_refund_graph(
            _DeterministicOrderLookup(
                configuration=request.order_lookup,
                order_context=order_context,
                tenant_id=request.tenant_id,
                environment_id=request.environment_id,
                recorder=recorder,
            ),
            _DeterministicIntentExtractor(intent=request.intent, recorder=recorder),
            _build_proposal_builder(),
            _DeterministicCustomerEvidenceLookup(
                outcome=request.customer_evidence_outcome,
                recorder=recorder,
            ),
            _DeterministicAnswerComposer(recorder=recorder),
        )

        started_at = self._clock()
        final_state: dict[str, Any] = {}
        for turn_number, turn in enumerate(request.execution_turns(), start=1):
            final_state = await _run_turn(
                graph=graph,
                turn=turn,
                tenant_id=request.tenant_id,
                environment_id=request.environment_id,
                case_id=case.case_id,
                repetition=repetition,
                turn_number=turn_number,
                recorder=recorder,
            )
        elapsed_ms = (self._clock() - started_at) * 1_000
        if elapsed_ms < 0:
            raise AgentRuntimeRefundAdapterError(
                "The monotonic evaluation clock moved backwards."
            )

        serialized_state = _to_json(final_state)
        return EvaluationSample(
            output={
                "status": serialized_state.get("status"),
                "error_code": serialized_state.get("error_code"),
                "customer_answer": _customer_answer_message(serialized_state),
                "refund_proposal": serialized_state.get("refund_proposal"),
            },
            final_state=serialized_state,
            trace=recorder.events,
            latency_ms=elapsed_ms,
            versions={
                "adapter": self.adapter_version,
                "graph": "build_refund_graph",
                "dependency_mode": "deterministic-synthetic",
            },
        )


async def _run_turn(
    *,
    graph: Any,
    turn: RefundAgentTurn,
    tenant_id: str,
    environment_id: str,
    case_id: str,
    repetition: int,
    turn_number: int,
    recorder: _TraceRecorder,
) -> dict[str, Any]:
    order_reference = turn.order_reference or turn.previous_order_reference
    state: dict[str, Any] = {
        "customer_message": turn.customer_message,
        "conversation_messages": turn.conversation_messages,
        "order_reference": order_reference,
        "tenant_id": tenant_id,
        "environment_id": environment_id,
        "turn_id": f"{case_id}-trial-{repetition}-turn-{turn_number}",
        "trace_id": f"{case_id}-trace-{repetition}",
    }
    observed_state = dict(state)
    async for update in graph.astream(state, stream_mode="updates"):
        for node_name, change in update.items():
            observed_change = _to_json(change)
            observed_state.update(observed_change)
            recorder.record(
                TraceEventKind.STATE_CHANGE,
                node_name,
                _state_observation(observed_change),
            )
    return observed_state


def _build_synthetic_order_context(order: SyntheticOrder) -> OrderContext:
    digest = sha256(
        f"{order.reference}\0{order.order_id}\0{order.observation_id}\0{order.amount_minor}".encode()
    ).hexdigest()
    amount = Money(amount_minor=order.amount_minor, currency="USD")
    return OrderContext(
        schema_version="1",
        observation_id=order.observation_id,
        observed_at=datetime(2026, 9, 6, 12, 0, tzinfo=UTC),
        source=OrderSource(
            provider="evaluation-fixture",
            order_id=order.order_id,
            facts_version=f"sha256:{digest}",
        ),
        reference=order.reference,
        status="DELIVERED",
        active=False,
        placed_at=datetime(2026, 9, 5, 12, 0, tzinfo=UTC),
        customer_ref=CustomerRef(customer_id="evaluation-customer"),
        total=amount,
        items=[
            OrderItem(
                item_id="evaluation-item-001",
                sku="EVALUATION-SKU",
                name="Evaluation item",
                quantity=1,
                unit_price=amount,
                line_total=amount,
            )
        ],
        payments=[],
        fulfillments=[],
    )


def _build_proposal_builder() -> RefundProposalBuilder:
    identifiers = count(1)
    return RefundProposalBuilder(
        versions=RefundProposalVersions(
            agent_release_id="agent-runtime-evaluation",
            prompt_bundle_version="refund-intent-evaluation",
            model_route_id="deterministic-evaluation",
            knowledge_release_id="evaluation-refund-policy-v1",
            guardrail_version="evaluation-guardrail-v1",
            evaluation_version="refund-agent-v1",
            order_lookup_tool_version="deterministic-lookup-v1",
        ),
        create_id=lambda: f"evaluation-id-{next(identifiers)}",
        now=lambda: datetime(2026, 9, 6, 12, 0, tzinfo=UTC),
    )


def _state_observation(change: dict[str, Any]) -> dict[str, Any]:
    keys = (
        "status",
        "error_code",
        "order_reference",
        "knowledge_retrieval_status",
        "answer_composition_status",
        "refund_proposal",
    )
    return {key: change[key] for key in keys if key in change}


def _customer_answer_message(state: dict[str, Any]) -> str | None:
    answer = state.get("customer_answer")
    if isinstance(answer, dict):
        message = answer.get("message")
        return message if isinstance(message, str) else None
    return None


def _to_json(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_json(item) for item in value]
    return value
