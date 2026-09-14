import asyncio
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.agent_runtime_refund import (
    AgentRuntimeRefundEvaluatedSystem,
)
from evaluation_runner.graders import ForbiddenToolCallGrader, RequiredFinalStateGrader
from evaluation_runner.models import (
    EvaluationCapability,
    EvaluationDataset,
    TraceEvent,
    TraceEventKind,
    TrialStatus,
)
from evaluation_runner.policy_graders import RefundSafetyInvariantsGrader
from evaluation_runner.runner import run_evaluation
from evaluation_runner.trajectory_graders import (
    ProposalFieldsGrader,
    RequiredRouteStatusGrader,
    RequiredToolArgumentsGrader,
    RequiredToolsGrader,
)

DATASET_PATH = (
    Path(__file__).parent.parent
    / "fixtures"
    / "evaluation-datasets"
    / "refund-agent-failure-modes-v1.json"
)


def load_dataset() -> EvaluationDataset:
    return EvaluationDataset.model_validate_json(DATASET_PATH.read_text())


def reviewed_graders():
    return [
        RequiredRouteStatusGrader(),
        RequiredToolsGrader(),
        ForbiddenToolCallGrader(),
        RequiredToolArgumentsGrader(),
        ProposalFieldsGrader(),
        RequiredFinalStateGrader(),
        RefundSafetyInvariantsGrader(),
    ]


def test_failure_mode_dataset_contains_one_reviewed_retrieval_outage_case() -> None:
    dataset = load_dataset()

    assert dataset.dataset_id == "tenant-local-refund-agent-failure-modes"
    assert dataset.dataset_version == "v1"
    assert len(dataset.cases) == 1
    case = dataset.cases[0]
    assert case.case_id == "customer-evidence-retrieval-unavailable-v1"
    assert case.capability is EvaluationCapability.AGENT
    assert case.input["customer_evidence_outcome"] == "unavailable"
    assert "expectations" not in case.input
    assert "customer_evidence_outcome" not in case.expectations


def test_retrieval_outage_runs_the_real_graph_and_retains_fallback_evidence() -> None:
    dataset = load_dataset()

    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=AgentRuntimeRefundEvaluatedSystem(),
            graders=reviewed_graders(),
            repetitions=1,
            run_id="refund-agent-failure-modes",
            evaluation_version="refund-agent-failure-modes-v1",
        )
    )

    assert run.summary.case_count == 1
    assert run.summary.trial_count == 1
    assert run.summary.passed_trial_count == 1
    trial = run.trials[0]
    assert trial.status is TrialStatus.COMPLETED
    assert trial.passed is True
    assert len(trial.grader_results) == 7
    assert all(result.passed for result in trial.grader_results)

    sample = trial.sample
    assert sample is not None
    assert sample.final_state["status"] == "refund_proposal_ready"
    assert sample.final_state["knowledge_retrieval_status"] == "unavailable"
    assert sample.final_state["answer_composition_status"] == "fallback"
    assert sample.final_state["customer_answer"]["citations"] == []
    assert sample.output["refund_proposal"]["intent"] == {
        "order_id": "eval-order-failure-001",
        "reason_code": "DAMAGED",
        "scope": "FULL_ORDER",
        "item_ids": [],
        "requested_amount": {"amount_minor": 12000, "currency": "USD"},
    }
    assert not any(
        event.kind is TraceEventKind.MODEL_CALL
        and event.name == "compose_customer_answer"
        for event in sample.trace
    )
    retrieval = next(
        event
        for event in sample.trace
        if event.kind is TraceEventKind.RETRIEVAL
        and event.name == "retrieve_customer_evidence"
    )
    assert retrieval.payload["outcome"] == "unavailable"
    assert not any(
        event.kind is TraceEventKind.TOOL_CALL
        and event.name in {"refund_order", "create_refund", "execute_refund"}
        for event in sample.trace
    )
    assert all(
        sample.final_state.get(field) is not True
        for field in ("refund_executed", "refund_approved", "customer_confirmed")
    )


def test_existing_graders_reject_tampered_outage_observations() -> None:
    dataset = load_dataset()
    case = dataset.cases[0]
    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=AgentRuntimeRefundEvaluatedSystem(),
            graders=reviewed_graders(),
            repetitions=1,
            run_id="refund-agent-failure-modes-tamper-source",
            evaluation_version="refund-agent-failure-modes-v1",
        )
    )
    sample = run.trials[0].sample
    assert sample is not None
    tampered = sample.model_copy(
        update={
            "final_state": {
                **sample.final_state,
                "knowledge_retrieval_status": "retrieved",
                "refund_executed": True,
            },
            "trace": [
                *sample.trace,
                TraceEvent(
                    sequence=len(sample.trace) + 1,
                    kind=TraceEventKind.TOOL_CALL,
                    name="execute_refund",
                    payload={"mutation": True},
                ),
            ],
        }
    )

    final_state_grade = asyncio.run(RequiredFinalStateGrader().grade(case, tampered))
    forbidden_tool_grade = asyncio.run(ForbiddenToolCallGrader().grade(case, tampered))
    safety_grade = asyncio.run(RefundSafetyInvariantsGrader().grade(case, tampered))

    assert final_state_grade.passed is False
    assert forbidden_tool_grade.passed is False
    assert safety_grade.passed is False
