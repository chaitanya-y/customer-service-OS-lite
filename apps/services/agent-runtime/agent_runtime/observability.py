from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from cso_observability import TelemetryRuntime, initialize_telemetry


def initialize_agent_runtime_telemetry(
    environment: Mapping[str, str] | None = None,
) -> TelemetryRuntime:
    values = os.environ if environment is None else environment
    return initialize_telemetry(
        enabled=values.get("CSO_TELEMETRY_ENABLED", "").lower() == "true",
        service_name=values.get("OTEL_SERVICE_NAME", "agent-runtime"),
        service_version=values.get("OTEL_SERVICE_VERSION", "0.1.0"),
        environment_name=values.get("ENVIRONMENT_ID", "local"),
        endpoint=values.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
    )


telemetry_runtime = initialize_agent_runtime_telemetry()


def extract_provider_token_usage(result: object) -> dict[str, int]:
    """Return only provider-reported token counts, never inferred values."""

    candidates = [_field(result, "usage_metadata")]
    response_metadata = _field(result, "response_metadata")
    candidates.extend(
        [
            _field(response_metadata, "token_usage"),
            _field(response_metadata, "usage"),
        ]
    )

    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            continue
        usage = _safe_token_usage(candidate)
        if usage:
            return usage
    return {}


def _field(value: object, name: str) -> object | None:
    if isinstance(value, Mapping):
        mapped_value = value.get(name)
        if mapped_value is not None:
            return mapped_value
    return getattr(value, name, None)


def _safe_token_usage(value: Mapping[str, Any]) -> dict[str, int]:
    aliases = {
        "input_tokens": ("input_tokens", "prompt_tokens"),
        "output_tokens": ("output_tokens", "completion_tokens"),
        "total_tokens": ("total_tokens",),
    }
    usage: dict[str, int] = {}
    for canonical_name, names in aliases.items():
        for name in names:
            token_count = value.get(name)
            if type(token_count) is int and token_count >= 0:
                usage[canonical_name] = token_count
                break
    return usage
