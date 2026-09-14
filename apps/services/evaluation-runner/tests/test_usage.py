import asyncio
from types import SimpleNamespace

import pytest

from evaluation_runner.usage import (
    PriceSchedule,
    TokenRate,
    UsageComponent,
    UsageRecorder,
    record_async_resource,
    record_sync_resource,
)


def response_with_usage(
    *,
    input_tokens: int = 100,
    output_tokens: int = 20,
    cached_tokens: int = 25,
    reasoning_tokens: int = 5,
):
    return SimpleNamespace(
        usage=SimpleNamespace(
            prompt_tokens=input_tokens,
            completion_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            prompt_tokens_details=SimpleNamespace(cached_tokens=cached_tokens),
            completion_tokens_details=SimpleNamespace(
                reasoning_tokens=reasoning_tokens
            ),
        ),
        choices=[SimpleNamespace(message=SimpleNamespace(content="private answer"))],
        headers={"authorization": "secret"},
    )


def test_recorder_aggregates_provider_usage_without_double_counting_subsets() -> None:
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.ANSWER,
        "answer-model",
        response_with_usage(),
    )
    recorder.record_success(
        UsageComponent.JUDGE,
        "judge-model",
        response_with_usage(input_tokens=50, output_tokens=10, cached_tokens=0),
    )

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=True,
    )

    assert report.measurement_status == "COMPLETE"
    answer = next(item for item in report.components if item.component == "answer")
    assert answer.input_tokens == 100
    assert answer.output_tokens == 20
    assert answer.cached_input_tokens == 25
    assert answer.reasoning_output_tokens == 5
    assert answer.total_tokens == 120
    assert report.total_tokens == 180
    serialized = report.model_dump_json()
    assert "private answer" not in serialized
    assert "authorization" not in serialized
    assert "secret" not in serialized


def test_missing_usage_is_unknown_not_zero_and_marks_measurement_partial() -> None:
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.QUERY_EMBEDDING,
        "embedding-model",
        SimpleNamespace(data=[]),
    )

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=True,
    )

    component = report.components[0]
    assert report.measurement_status == "UNAVAILABLE"
    assert component.attempted_calls == 1
    assert component.measured_calls == 0
    assert component.input_tokens is None
    assert component.total_tokens is None
    assert report.total_tokens is None
    assert report.estimated_cost_usd is None


def test_resource_wrappers_record_success_and_provider_failure() -> None:
    class SyncResource:
        def create(self, **kwargs):
            del kwargs
            return response_with_usage(
                input_tokens=7,
                output_tokens=0,
                cached_tokens=0,
                reasoning_tokens=0,
            )

    class AsyncResource:
        async def create(self, **kwargs):
            del kwargs
            raise RuntimeError("provider unavailable")

    recorder = UsageRecorder()
    sync = record_sync_resource(
        SyncResource(), recorder, UsageComponent.QUERY_EMBEDDING, "embedding-model"
    )
    async_resource = record_async_resource(
        AsyncResource(), recorder, UsageComponent.JUDGE, "judge-model"
    )

    sync.create(input=["private prompt"])
    with pytest.raises(RuntimeError, match="provider unavailable"):
        asyncio.run(async_resource.create(messages=["private prompt"]))

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=False,
    )
    assert report.measurement_status == "PARTIAL"
    by_component = {item.component: item for item in report.components}
    assert by_component["query_embedding"].measured_calls == 1
    assert by_component["judge"].failed_calls == 1
    assert "private prompt" not in report.model_dump_json()


def test_explicit_versioned_schedule_estimates_cost_with_cached_rate() -> None:
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.ANSWER,
        "answer-model",
        response_with_usage(
            input_tokens=1_000_000,
            output_tokens=200_000,
            cached_tokens=400_000,
            reasoning_tokens=50_000,
        ),
    )
    schedule = PriceSchedule(
        version="synthetic-prices-v1",
        currency="USD",
        effective_date="2099-01-01",
        rates=[
            TokenRate(
                provider="openai",
                model="answer-model",
                input_usd_per_million_tokens=2,
                cached_input_usd_per_million_tokens=0.5,
                output_usd_per_million_tokens=10,
            )
        ],
    )

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=True,
        price_schedule=schedule,
    )

    # 600k uncached * $2/M + 400k cached * $0.50/M + 200k output * $10/M.
    assert report.estimated_cost_usd == pytest.approx(3.4)
    assert report.pricing_schedule_version == "synthetic-prices-v1"


def test_cost_is_unknown_when_schedule_has_no_exact_model_match() -> None:
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.ANSWER,
        "answer-model",
        response_with_usage(),
    )
    schedule = PriceSchedule(
        version="synthetic-prices-v1",
        currency="USD",
        effective_date="2099-01-01",
        rates=[
            TokenRate(
                provider="openai",
                model="different-model",
                input_usd_per_million_tokens=1,
                cached_input_usd_per_million_tokens=1,
                output_usd_per_million_tokens=1,
            )
        ],
    )

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=True,
        price_schedule=schedule,
    )

    assert report.estimated_cost_usd is None


@pytest.mark.parametrize(
    ("cached_rate", "expected_cost"),
    [(2.0, 2.0), (0.5, None)],
)
def test_unknown_cached_count_is_priceable_only_when_input_rates_match(
    cached_rate: float,
    expected_cost: float | None,
) -> None:
    recorder = UsageRecorder()
    recorder.record_success(
        UsageComponent.QUERY_EMBEDDING,
        "embedding-model",
        {
            "usage": {
                "prompt_tokens": 1_000_000,
                "total_tokens": 1_000_000,
            }
        },
    )
    schedule = PriceSchedule(
        version="synthetic-prices-v1",
        currency="USD",
        effective_date="2099-01-01",
        rates=[
            TokenRate(
                provider="openai",
                model="embedding-model",
                input_usd_per_million_tokens=2,
                cached_input_usd_per_million_tokens=cached_rate,
                output_usd_per_million_tokens=0,
            )
        ],
    )

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=True,
        price_schedule=schedule,
    )

    if expected_cost is None:
        assert report.estimated_cost_usd is None
    else:
        assert report.estimated_cost_usd == pytest.approx(expected_cost)
    assert report.cached_input_tokens is None
    assert report.reasoning_output_tokens is None


def test_usage_remains_measured_when_downstream_rejects_truncated_response() -> None:
    recorder = UsageRecorder()
    response = response_with_usage(input_tokens=30, output_tokens=8, cached_tokens=0)
    response.choices[0].finish_reason = "length"
    recorder.record_success(UsageComponent.JUDGE, "judge-model", response)

    report = recorder.build_report(
        run_id="run-1",
        evaluation_version="evaluation-v1",
        run_succeeded=False,
    )

    assert report.run_status == "FAILED"
    assert report.measurement_status == "COMPLETE"
    assert report.total_tokens == 38


@pytest.mark.parametrize("invalid_rate", [float("nan"), float("inf")])
def test_price_schedule_rejects_non_finite_rates(invalid_rate: float) -> None:
    with pytest.raises(ValueError):
        TokenRate(
            provider="openai",
            model="answer-model",
            input_usd_per_million_tokens=invalid_rate,
            cached_input_usd_per_million_tokens=1,
            output_usd_per_million_tokens=1,
        )
