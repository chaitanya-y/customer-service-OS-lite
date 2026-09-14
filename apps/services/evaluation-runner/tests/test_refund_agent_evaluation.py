import asyncio
from pathlib import Path

import pytest

pytest.importorskip("agent_runtime")

from evaluation_runner.adapters.agent_runtime_refund import (
    AgentRuntimeRefundEvaluatedSystem,
)
from evaluation_runner.graders import ForbiddenToolCallGrader, RequiredFinalStateGrader
from evaluation_runner.models import EvaluationDataset, TrialStatus
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
    / "refund-agent-v1.json"
)


def test_refund_agent_fixture_passes_all_reviewed_trajectory_and_safety_graders() -> (
    None
):
    dataset = EvaluationDataset.model_validate_json(DATASET_PATH.read_text())

    run = asyncio.run(
        run_evaluation(
            dataset=dataset,
            system=AgentRuntimeRefundEvaluatedSystem(),
            graders=[
                RequiredRouteStatusGrader(),
                RequiredToolsGrader(),
                ForbiddenToolCallGrader(),
                RequiredToolArgumentsGrader(),
                ProposalFieldsGrader(),
                RequiredFinalStateGrader(),
                RefundSafetyInvariantsGrader(),
            ],
            repetitions=1,
            run_id="refund-agent-fixture",
            evaluation_version="refund-agent-v1",
        )
    )

    assert [trial.status for trial in run.trials] == [TrialStatus.COMPLETED] * 7
    assert all(trial.passed for trial in run.trials)
    assert run.summary.case_count == 7
    assert run.summary.passed_trial_count == 7
