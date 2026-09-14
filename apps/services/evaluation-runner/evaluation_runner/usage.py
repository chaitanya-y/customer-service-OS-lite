from __future__ import annotations

from collections.abc import Mapping
from datetime import date
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class UsageComponent(StrEnum):
    ANSWER = "answer"
    QUERY_EMBEDDING = "query_embedding"
    JUDGE = "judge"
    JUDGE_EMBEDDING = "judge_embedding"


class TokenRate(BaseModel):
    """An exact provider/model rate supplied by the caller, never fetched."""

    model_config = ConfigDict(frozen=True)

    provider: str = Field(min_length=1)
    model: str = Field(min_length=1)
    input_usd_per_million_tokens: float = Field(ge=0, allow_inf_nan=False)
    cached_input_usd_per_million_tokens: float = Field(ge=0, allow_inf_nan=False)
    output_usd_per_million_tokens: float = Field(ge=0, allow_inf_nan=False)


class PriceSchedule(BaseModel):
    """Versioned caller-owned prices used only for an estimated USD cost."""

    model_config = ConfigDict(frozen=True)

    version: str = Field(min_length=1)
    currency: Literal["USD"]
    effective_date: date
    rates: list[TokenRate] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_rates(self) -> PriceSchedule:
        keys = [(rate.provider, rate.model) for rate in self.rates]
        if len(keys) != len(set(keys)):
            raise ValueError("Price schedule provider/model entries must be unique.")
        return self


class ComponentUsage(BaseModel):
    """Content-free aggregate for one provider component and model."""

    model_config = ConfigDict(frozen=True)

    component: UsageComponent
    provider: str = "openai"
    model: str = Field(min_length=1)
    attempted_calls: int = Field(ge=0)
    succeeded_calls: int = Field(ge=0)
    failed_calls: int = Field(ge=0)
    measured_calls: int = Field(ge=0)
    input_tokens: int | None = Field(ge=0)
    output_tokens: int | None = Field(ge=0)
    cached_input_tokens: int | None = Field(ge=0)
    reasoning_output_tokens: int | None = Field(ge=0)
    total_tokens: int | None = Field(ge=0)


class EvaluationUsageReport(BaseModel):
    """Authoritative usage sidecar; legacy sample zeroes are unmeasured history."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal["evaluation-usage-v1"] = "evaluation-usage-v1"
    run_id: str = Field(min_length=1)
    evaluation_version: str = Field(min_length=1)
    run_status: Literal["COMPLETED", "FAILED"]
    measurement_status: Literal["COMPLETE", "PARTIAL", "UNAVAILABLE", "FAILED"]
    components: list[ComponentUsage]
    input_tokens: int | None = Field(ge=0)
    output_tokens: int | None = Field(ge=0)
    cached_input_tokens: int | None = Field(ge=0)
    reasoning_output_tokens: int | None = Field(ge=0)
    total_tokens: int | None = Field(ge=0)
    estimated_cost_usd: float | None = Field(ge=0)
    pricing_schedule_version: str | None
    pricing_currency: Literal["USD"] | None
    pricing_effective_date: date | None


class _MutableUsage:
    def __init__(self, component: UsageComponent, model: str) -> None:
        self.component = component
        self.model = model
        self.attempted_calls = 0
        self.succeeded_calls = 0
        self.failed_calls = 0
        self.measured_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cached_input_tokens = 0
        self.reasoning_output_tokens = 0
        self.total_tokens = 0
        self.complete = True
        self.cached_complete = True
        self.reasoning_complete = True


class UsageRecorder:
    """Collect provider-reported counters without retaining request/response content."""

    def __init__(self) -> None:
        self._usage: dict[tuple[UsageComponent, str], _MutableUsage] = {}

    def register(self, component: UsageComponent, model: str) -> None:
        self._entry(component, model)

    def record_success(
        self,
        component: UsageComponent,
        model: str,
        response: object,
    ) -> None:
        entry = self._entry(component, model)
        entry.attempted_calls += 1
        entry.succeeded_calls += 1
        usage = _read_value(response, "usage")
        parsed = _parse_usage(usage)
        if parsed is None:
            entry.complete = False
            return
        entry.measured_calls += 1
        entry.input_tokens += parsed[0]
        entry.output_tokens += parsed[1]
        if parsed[2] is None:
            entry.cached_complete = False
        else:
            entry.cached_input_tokens += parsed[2]
        if parsed[3] is None:
            entry.reasoning_complete = False
        else:
            entry.reasoning_output_tokens += parsed[3]
        entry.total_tokens += parsed[4]

    def record_failure(self, component: UsageComponent, model: str) -> None:
        entry = self._entry(component, model)
        entry.attempted_calls += 1
        entry.failed_calls += 1
        entry.complete = False

    def build_report(
        self,
        *,
        run_id: str,
        evaluation_version: str,
        run_succeeded: bool,
        price_schedule: PriceSchedule | None = None,
    ) -> EvaluationUsageReport:
        components = [self._component(entry) for entry in self._usage.values()]
        components.sort(key=lambda item: (item.component, item.model))
        attempted = sum(item.attempted_calls for item in components)
        all_measured = all(
            item.measured_calls == item.succeeded_calls and item.failed_calls == 0
            for item in components
        )
        any_measured = any(item.measured_calls for item in components)
        if attempted == 0:
            measurement_status = "UNAVAILABLE"
        elif all_measured:
            measurement_status = "COMPLETE"
        elif any_measured:
            measurement_status = "PARTIAL"
        elif any(item.failed_calls for item in components):
            measurement_status = "FAILED"
        else:
            measurement_status = "UNAVAILABLE"

        totals_known = attempted > 0 and all_measured
        input_tokens = (
            _sum_optional(components, "input_tokens") if totals_known else None
        )
        output_tokens = (
            _sum_optional(components, "output_tokens") if totals_known else None
        )
        cached_tokens = (
            _sum_optional(components, "cached_input_tokens") if totals_known else None
        )
        reasoning_tokens = (
            _sum_optional(components, "reasoning_output_tokens")
            if totals_known
            else None
        )
        total_tokens = (
            _sum_optional(components, "total_tokens") if totals_known else None
        )
        estimated_cost = (
            _estimate_cost(components, price_schedule)
            if totals_known and price_schedule is not None
            else None
        )
        return EvaluationUsageReport(
            run_id=run_id,
            evaluation_version=evaluation_version,
            run_status="COMPLETED" if run_succeeded else "FAILED",
            measurement_status=measurement_status,
            components=components,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cached_input_tokens=cached_tokens,
            reasoning_output_tokens=reasoning_tokens,
            total_tokens=total_tokens,
            estimated_cost_usd=estimated_cost,
            pricing_schedule_version=(
                price_schedule.version if price_schedule is not None else None
            ),
            pricing_currency=(
                price_schedule.currency if price_schedule is not None else None
            ),
            pricing_effective_date=(
                price_schedule.effective_date if price_schedule is not None else None
            ),
        )

    def _entry(self, component: UsageComponent, model: str) -> _MutableUsage:
        key = (component, model)
        if key not in self._usage:
            self._usage[key] = _MutableUsage(component, model)
        return self._usage[key]

    @staticmethod
    def _component(entry: _MutableUsage) -> ComponentUsage:
        known = entry.complete and entry.measured_calls == entry.succeeded_calls
        return ComponentUsage(
            component=entry.component,
            model=entry.model,
            attempted_calls=entry.attempted_calls,
            succeeded_calls=entry.succeeded_calls,
            failed_calls=entry.failed_calls,
            measured_calls=entry.measured_calls,
            input_tokens=entry.input_tokens if known else None,
            output_tokens=entry.output_tokens if known else None,
            cached_input_tokens=(
                entry.cached_input_tokens if known and entry.cached_complete else None
            ),
            reasoning_output_tokens=(
                entry.reasoning_output_tokens
                if known and entry.reasoning_complete
                else None
            ),
            total_tokens=entry.total_tokens if known else None,
        )


class _SyncRecordingResource:
    def __init__(self, resource, recorder, component, model) -> None:
        self._resource = resource
        self._recorder = recorder
        self._component = component
        self._model = model

    def create(self, *args, **kwargs):
        return self._record(self._resource.create, *args, **kwargs)

    def parse(self, *args, **kwargs):
        return self._record(self._resource.parse, *args, **kwargs)

    @property
    def with_raw_response(self):
        return _SyncRawRecordingResource(
            self._resource.with_raw_response,
            self._recorder,
            self._component,
            self._model,
        )

    def __getattr__(self, name: str):
        return getattr(self._resource, name)

    def _record(self, method, *args, **kwargs):
        try:
            response = method(*args, **kwargs)
        except Exception:
            self._recorder.record_failure(self._component, self._model)
            raise
        self._recorder.record_success(self._component, self._model, response)
        return response


class _AsyncRecordingResource:
    def __init__(self, resource, recorder, component, model) -> None:
        self._resource = resource
        self._recorder = recorder
        self._component = component
        self._model = model

    async def create(self, *args, **kwargs):
        return await self._record(self._resource.create, *args, **kwargs)

    async def parse(self, *args, **kwargs):
        return await self._record(self._resource.parse, *args, **kwargs)

    @property
    def with_raw_response(self):
        return _AsyncRawRecordingResource(
            self._resource.with_raw_response,
            self._recorder,
            self._component,
            self._model,
        )

    def __getattr__(self, name: str):
        return getattr(self._resource, name)

    async def _record(self, method, *args, **kwargs):
        try:
            response = await method(*args, **kwargs)
        except Exception:
            self._recorder.record_failure(self._component, self._model)
            raise
        self._recorder.record_success(self._component, self._model, response)
        return response


class _SyncRawRecordingResource:
    def __init__(self, resource, recorder, component, model) -> None:
        self._resource = resource
        self._recorder = recorder
        self._component = component
        self._model = model

    def parse(self, *args, **kwargs):
        try:
            raw_response = self._resource.parse(*args, **kwargs)
            parsed_response = raw_response.parse()
        except Exception:
            self._recorder.record_failure(self._component, self._model)
            raise
        self._recorder.record_success(self._component, self._model, parsed_response)
        return raw_response

    def __getattr__(self, name: str):
        return getattr(self._resource, name)


class _AsyncRawRecordingResource:
    def __init__(self, resource, recorder, component, model) -> None:
        self._resource = resource
        self._recorder = recorder
        self._component = component
        self._model = model

    async def parse(self, *args, **kwargs):
        try:
            raw_response = await self._resource.parse(*args, **kwargs)
            parsed_response = raw_response.parse()
        except Exception:
            self._recorder.record_failure(self._component, self._model)
            raise
        self._recorder.record_success(self._component, self._model, parsed_response)
        return raw_response

    def __getattr__(self, name: str):
        return getattr(self._resource, name)


def record_sync_resource(resource, recorder, component, model):
    return _SyncRecordingResource(resource, recorder, component, model)


def record_async_resource(resource, recorder, component, model):
    return _AsyncRecordingResource(resource, recorder, component, model)


def _parse_usage(
    usage: object,
) -> tuple[int, int, int | None, int | None, int] | None:
    if usage is None:
        return None
    input_tokens = _optional_int(usage, "prompt_tokens", "input_tokens")
    output_tokens = _optional_int(usage, "completion_tokens", "output_tokens")
    total_tokens = _optional_int(usage, "total_tokens")
    if input_tokens is None or total_tokens is None:
        return None
    if output_tokens is None:
        output_tokens = total_tokens - input_tokens
    if output_tokens < 0 or total_tokens != input_tokens + output_tokens:
        return None
    prompt_details = _first_value(
        usage, "prompt_tokens_details", "input_tokens_details"
    )
    completion_details = _first_value(
        usage, "completion_tokens_details", "output_tokens_details"
    )
    cached_tokens = _optional_int(prompt_details, "cached_tokens")
    reasoning_tokens = _optional_int(completion_details, "reasoning_tokens")
    if (cached_tokens is not None and cached_tokens > input_tokens) or (
        reasoning_tokens is not None and reasoning_tokens > output_tokens
    ):
        return None
    return input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens


def _estimate_cost(
    components: list[ComponentUsage],
    schedule: PriceSchedule,
) -> float | None:
    rates = {(rate.provider, rate.model): rate for rate in schedule.rates}
    total = 0.0
    for component in components:
        if component.attempted_calls == 0:
            continue
        rate = rates.get((component.provider, component.model))
        if (
            rate is None
            or component.input_tokens is None
            or component.output_tokens is None
        ):
            return None
        if component.cached_input_tokens is None:
            if (
                rate.input_usd_per_million_tokens
                != rate.cached_input_usd_per_million_tokens
            ):
                return None
            cached_input_tokens = 0
        else:
            cached_input_tokens = component.cached_input_tokens
        uncached = component.input_tokens - cached_input_tokens
        total += uncached * rate.input_usd_per_million_tokens / 1_000_000
        total += (
            cached_input_tokens * rate.cached_input_usd_per_million_tokens / 1_000_000
        )
        total += (
            component.output_tokens * rate.output_usd_per_million_tokens / 1_000_000
        )
    return total


def _sum_optional(components: list[ComponentUsage], field: str) -> int | None:
    values = [
        getattr(component, field)
        for component in components
        if component.attempted_calls > 0
    ]
    if any(value is None for value in values):
        return None
    return sum(value for value in values if value is not None)


def _read_value(value: object, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _first_value(value: object, *names: str) -> Any:
    for name in names:
        result = _read_value(value, name)
        if result is not None:
            return result
    return None


def _optional_int(value: object, *names: str) -> int | None:
    raw = _first_value(value, *names)
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        return None
    return raw
