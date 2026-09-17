from __future__ import annotations

import os
from collections.abc import Mapping

from cso_observability import TelemetryRuntime, TelemetryState, initialize_telemetry

_TELEMETRY_STATE = TelemetryState()


def initialize_knowledge_rag_telemetry(
    environment: Mapping[str, str] | None = None,
    *,
    state: TelemetryState = _TELEMETRY_STATE,
) -> TelemetryRuntime:
    values = os.environ if environment is None else environment
    return initialize_telemetry(
        enabled=values.get("CSO_TELEMETRY_ENABLED", "").lower() == "true",
        service_name=values.get("OTEL_SERVICE_NAME", "knowledge-rag"),
        service_version=values.get("OTEL_SERVICE_VERSION", "0.1.0"),
        environment_name=values.get("ENVIRONMENT_ID", "local"),
        endpoint=values.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318"),
        state=state,
    )


telemetry_runtime = initialize_knowledge_rag_telemetry()
