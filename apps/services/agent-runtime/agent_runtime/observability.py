from __future__ import annotations

import os
from collections.abc import Mapping

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
