from evaluation_runner.langsmith_export import build_langsmith_export_record
from evaluation_runner.models import (
    CaseSummary,
    EvaluationRun,
    EvaluationSample,
    GraderResult,
    RunSummary,
    TraceEvent,
    TraceEventKind,
    TrialResult,
    TrialStatus,
)


def make_run() -> EvaluationRun:
    trial = TrialResult(
        trial_id="run-safe-1:case-safe-1:1",
        case_id="case-safe-1",
        repetition=1,
        status=TrialStatus.COMPLETED,
        passed=True,
        sample=EvaluationSample(
            output={"answer": "CANARY customer answer"},
            final_state={"customer_id": "customer-CANARY"},
            trace=[
                TraceEvent(
                    sequence=1,
                    kind=TraceEventKind.MODEL_CALL,
                    name="answer",
                    payload={"prompt": "CANARY private prompt"},
                )
            ],
            latency_ms=125,
            input_tokens=50,
            output_tokens=10,
            estimated_cost_usd=0.01,
            versions={
                "answer_prompt": "refund-answer-v4",
                "model_route_id": "refund-answer-evaluation",
                "customer_id": "customer-CANARY",
            },
        ),
        grader_results=[
            GraderResult(
                grader_name="answer-safety",
                grader_version="v2",
                score=1.0,
                passed=True,
                blocking=True,
                reasons=["CANARY private grader reason"],
                details={"tenant_id": "tenant-CANARY"},
            )
        ],
    )
    return EvaluationRun(
        run_id="run-safe-1",
        dataset_id="refund-agent",
        dataset_version="v4",
        dataset_case_ids=["case-safe-1"],
        evaluation_version="evaluation-v7",
        repetitions=1,
        trials=[trial],
        case_summaries=[
            CaseSummary(
                case_id="case-safe-1",
                trial_count=1,
                passed_trial_count=1,
                pass_rate=1.0,
                all_trials_passed=True,
            )
        ],
        summary=RunSummary(
            case_count=1,
            trial_count=1,
            passed_trial_count=1,
            pass_rate=1.0,
            consistent_case_count=1,
            consistent_case_rate=1.0,
        ),
    )


def test_langsmith_export_is_disabled_by_default() -> None:
    assert build_langsmith_export_record(make_run()) is None


def test_enabled_langsmith_export_preserves_safe_versions_and_aggregate_metrics_only() -> None:
    record = build_langsmith_export_record(make_run(), enabled=True)

    assert record is not None
    assert record.run_id == "run-safe-1"
    assert record.dataset_id == "refund-agent"
    assert record.dataset_version == "v4"
    assert record.evaluation_version == "evaluation-v7"
    assert record.prompt_versions == ["refund-answer-v4"]
    assert record.model_route_versions == ["refund-answer-evaluation"]
    assert [item.model_dump() for item in record.grader_versions] == [
        {"grader_name": "answer-safety", "grader_version": "v2"}
    ]
    assert record.summary.trial_count == 1
    assert record.grader_metrics[0].mean_score == 1.0
    assert record.grader_metrics[0].passed_trial_count == 1
    serialized = record.model_dump_json()
    assert "CANARY" not in serialized
    assert "customer_id" not in serialized
    assert "tenant_id" not in serialized
    assert "CANARY private prompt" not in serialized
    assert "CANARY customer answer" not in serialized
