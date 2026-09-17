from __future__ import annotations

import logging
import re
import threading
import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from opentelemetry import trace
from opentelemetry._logs import SeverityNumber
from opentelemetry.context import Context
from opentelemetry.propagators.textmap import Getter
from opentelemetry.sdk._logs import LoggerProvider, LogRecordProcessor
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    MetricReader,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.metrics.view import (
    ExplicitBucketHistogramAggregation,
    View,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanProcessor
from opentelemetry.trace import SpanKind, Status, StatusCode
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

_SAFE_RESOURCE_VALUE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_DURATION_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10)
_DEFAULT_EXPORT_TIMEOUT_MILLIS = 1_000
_OPERATION_NAMES = frozenset(
    {
        "knowledge.retrieve",
        "mcp.lookup_order",
        "rag.fusion",
        "rag.keyword_search",
        "rag.query_embedding",
        "rag.rerank",
        "rag.vector_search",
    }
)
_DEFAULT_STATE: TelemetryState | None = None
_EXPORTER_LOGGERS = (
    "opentelemetry.exporter.otlp.proto.http.trace_exporter",
    "opentelemetry.exporter.otlp.proto.http.metric_exporter",
    "opentelemetry.exporter.otlp.proto.http._log_exporter",
    "opentelemetry.sdk._shared_internal",
    "opentelemetry.sdk.metrics._internal.export",
    "opentelemetry.sdk.trace.export",
    "opentelemetry.sdk._logs._internal.export",
    "opentelemetry.sdk._logs._internal.export.propagate.false",
)


class _SafeExporterDiagnosticFilter(logging.Filter):
    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._last_emitted_at = 0.0

    def filter(self, record: logging.LogRecord) -> bool:
        now = time.monotonic()
        with self._lock:
            if now - self._last_emitted_at < 60:
                return False
            self._last_emitted_at = now
        record.msg = "telemetry.unavailable"
        record.args = ()
        record.exc_info = None
        record.exc_text = None
        return True

    def reset(self) -> None:
        with self._lock:
            self._last_emitted_at = 0.0


_SAFE_EXPORTER_DIAGNOSTIC_FILTER = _SafeExporterDiagnosticFilter()
_EXPORTER_FILTER_LOCK = threading.Lock()
_EXPORTER_FILTER_INSTALLED = False


class _TraceParentGetter(Getter[Mapping[str, str]]):
    def get(self, carrier: Mapping[str, str], key: str) -> list[str] | None:
        value = carrier.get(key)
        return [value] if value is not None else None

    def keys(self, carrier: Mapping[str, str]) -> list[str]:
        return list(carrier)


@dataclass
class TelemetryState:
    """Owns one idempotent telemetry initialization boundary."""

    runtime: TelemetryRuntime | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


class TelemetryRuntime:
    def __init__(
        self,
        *,
        enabled: bool,
        tracer_provider: TracerProvider | None = None,
        meter_provider: MeterProvider | None = None,
        logger_provider: LoggerProvider | None = None,
    ) -> None:
        self.enabled = enabled
        self._tracer_provider = tracer_provider
        self._meter_provider = meter_provider
        self._logger_provider = logger_provider
        self._shutdown_started = False
        self._shutdown_lock = threading.Lock()
        self._shutdown_completed = threading.Event()

        if not enabled:
            self._tracer = None
            self._completed = None
            self._duration = None
            self._logger = None
            return

        assert tracer_provider is not None
        assert meter_provider is not None
        assert logger_provider is not None
        self._tracer = tracer_provider.get_tracer("cso_observability")
        meter = meter_provider.get_meter("cso_observability")
        self._completed = meter.create_counter("cso.operation.completed")
        self._duration = meter.create_histogram(
            "cso.operation.duration",
            unit="s",
        )
        self._logger = logger_provider.get_logger("cso_observability")

    def attach_asgi(self, app: Any) -> None:
        if not self.enabled or getattr(app.state, "cso_telemetry_attached", False):
            return
        app.add_middleware(_TelemetryMiddleware, runtime=self)
        app.state.cso_telemetry_attached = True

    @contextmanager
    def operation(self, name: str) -> Iterator[None]:
        if name not in _OPERATION_NAMES:
            raise ValueError("operation must use a bounded static name")
        if not self.enabled:
            yield
            return

        assert self._tracer is not None
        started_at = time.monotonic()
        with self._tracer.start_as_current_span(
            name,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                yield
            except BaseException:
                self._complete_operation(
                    span,
                    name,
                    "server_error",
                    started_at,
                )
                raise
            else:
                self._complete_operation(span, name, "success", started_at)

    def trace_headers(self) -> dict[str, str]:
        if not self.enabled:
            return {}
        carrier: dict[str, str] = {}
        TraceContextTextMapPropagator().inject(carrier)
        traceparent = carrier.get("traceparent")
        return {"traceparent": traceparent} if traceparent is not None else {}

    def force_flush(self, timeout_millis: int = 1_000) -> bool:
        if not self.enabled:
            return True
        providers = (
            self._tracer_provider,
            self._meter_provider,
            self._logger_provider,
        )
        results = [
            provider is not None and provider.force_flush(timeout_millis)
            for provider in providers
        ]
        return all(results)

    def shutdown(self, timeout_seconds: float = 2.0) -> bool:
        if not self.enabled:
            return True
        with self._shutdown_lock:
            should_start = not self._shutdown_started
            if should_start:
                self._shutdown_started = True

        def close_providers() -> None:
            try:
                assert self._tracer_provider is not None
                assert self._meter_provider is not None
                assert self._logger_provider is not None
                self._tracer_provider.shutdown()
                self._meter_provider.shutdown(
                    timeout_millis=max(1, int(timeout_seconds * 1_000))
                )
                self._logger_provider.shutdown()
            finally:
                self._shutdown_completed.set()

        if should_start:
            thread = threading.Thread(
                target=close_providers,
                name="cso-telemetry-shutdown",
                daemon=True,
            )
            thread.start()
        return self._shutdown_completed.wait(timeout=max(0, timeout_seconds))

    async def _handle_http(
        self, app: Any, scope: dict[str, Any], receive: Any, send: Any
    ) -> None:
        assert self._tracer is not None
        method = _safe_method(scope.get("method"))
        parent_context = _extract_parent(scope)
        status_code = 500
        response_complete = False
        started_at = time.monotonic()

        async def telemetry_send(message: dict[str, Any]) -> None:
            nonlocal response_complete, status_code
            if message["type"] == "http.response.start":
                status_code = int(message["status"])
            elif message["type"] == "http.response.body" and not message.get(
                "more_body", False
            ):
                response_complete = True
            await send(message)

        with self._tracer.start_as_current_span(
            f"{method} unmatched",
            context=parent_context,
            kind=SpanKind.SERVER,
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                await app(scope, receive, telemetry_send)
            except BaseException:
                status_code = 500
                self._complete(span, method, scope, status_code, started_at)
                raise
            else:
                if not response_complete:
                    status_code = 500
                self._complete(span, method, scope, status_code, started_at)

    def _complete(
        self,
        span: trace.Span,
        method: str,
        scope: Mapping[str, Any],
        status_code: int,
        started_at: float,
    ) -> None:
        operation = f"{method} {_route_template(scope)}"
        outcome = _outcome(status_code)
        attributes = {
            "operation": operation,
            "outcome": outcome,
            "http.request.method": method,
            "http.response.status_code": status_code,
        }
        span.update_name(operation)
        span.set_attributes(attributes)
        if status_code >= 500:
            span.set_status(Status(StatusCode.ERROR))

        elapsed = max(0.0, time.monotonic() - started_at)
        metric_attributes = {
            "operation": operation,
            "outcome": outcome,
            "http.response.status_code": status_code,
        }
        assert self._completed is not None
        assert self._duration is not None
        assert self._logger is not None
        self._completed.add(1, metric_attributes)
        self._duration.record(elapsed, metric_attributes)
        context = span.get_span_context()
        self._logger.emit(
            timestamp=time.time_ns(),
            severity_number=SeverityNumber.INFO,
            severity_text="INFO",
            body="request.completed",
            attributes={
                **metric_attributes,
                "trace_id": format(context.trace_id, "032x"),
                "span_id": format(context.span_id, "016x"),
            },
        )

    def _complete_operation(
        self,
        span: trace.Span,
        operation: str,
        outcome: str,
        started_at: float,
    ) -> None:
        attributes = {"operation": operation, "outcome": outcome}
        if outcome == "server_error":
            attributes["error.type"] = "application_error"
            span.set_status(Status(StatusCode.ERROR))
        span.set_attributes(attributes)

        elapsed = max(0.0, time.monotonic() - started_at)
        assert self._completed is not None
        assert self._duration is not None
        assert self._logger is not None
        self._completed.add(1, attributes)
        self._duration.record(elapsed, attributes)
        context = span.get_span_context()
        self._logger.emit(
            timestamp=time.time_ns(),
            severity_number=SeverityNumber.INFO,
            severity_text="INFO",
            body="operation.completed",
            attributes={
                **attributes,
                "trace_id": format(context.trace_id, "032x"),
                "span_id": format(context.span_id, "016x"),
            },
        )


class _TelemetryMiddleware:
    def __init__(self, app: Any, runtime: TelemetryRuntime) -> None:
        self.app = app
        self.runtime = runtime

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        await self.runtime._handle_http(self.app, scope, receive, send)


def initialize_telemetry(
    *,
    enabled: bool,
    service_name: str,
    service_version: str,
    environment_name: str,
    endpoint: str = "http://127.0.0.1:4318",
    state: TelemetryState | None = None,
    span_processor: SpanProcessor | None = None,
    metric_reader: MetricReader | None = None,
    log_processor: LogRecordProcessor | None = None,
    diagnostic: Callable[[str], None] | None = None,
) -> TelemetryRuntime:
    global _DEFAULT_STATE
    if state is None:
        if _DEFAULT_STATE is None:
            _DEFAULT_STATE = TelemetryState()
        state = _DEFAULT_STATE

    with state.lock:
        if state.runtime is not None:
            return state.runtime
        if not enabled:
            state.runtime = TelemetryRuntime(enabled=False)
            return state.runtime
        try:
            _install_safe_exporter_diagnostics()
            resource = Resource(
                attributes={
                    "service.name": _safe_resource_value(service_name, "service name"),
                    "service.version": _safe_resource_value(
                        service_version, "service version"
                    ),
                    "deployment.environment.name": _safe_resource_value(
                        environment_name, "environment name"
                    ),
                }
            )
            if span_processor is None or metric_reader is None or log_processor is None:
                span_processor, metric_reader, log_processor = _production_processors(
                    endpoint
                )

            tracer_provider = TracerProvider(resource=resource, shutdown_on_exit=False)
            tracer_provider.add_span_processor(span_processor)
            meter_provider = MeterProvider(
                metric_readers=(metric_reader,),
                resource=resource,
                shutdown_on_exit=False,
                views=(
                    View(
                        instrument_name="cso.operation.duration",
                        aggregation=ExplicitBucketHistogramAggregation(
                            boundaries=_DURATION_BUCKETS
                        ),
                    ),
                ),
            )
            logger_provider = LoggerProvider(resource=resource, shutdown_on_exit=False)
            logger_provider.add_log_record_processor(log_processor)
            state.runtime = TelemetryRuntime(
                enabled=True,
                tracer_provider=tracer_provider,
                meter_provider=meter_provider,
                logger_provider=logger_provider,
            )
        except Exception:  # noqa: BLE001 - telemetry must not abort app startup
            _emit_diagnostic(diagnostic)
            state.runtime = TelemetryRuntime(enabled=False)
        return state.runtime


def _production_processors(
    endpoint: str,
) -> tuple[SpanProcessor, MetricReader, LogRecordProcessor]:
    from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
    from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
        OTLPMetricExporter,
    )
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

    base_endpoint = _validated_endpoint(endpoint)
    span_exporter = OTLPSpanExporter(
        endpoint=f"{base_endpoint}/v1/traces",
        timeout=_DEFAULT_EXPORT_TIMEOUT_MILLIS / 1_000,
    )
    metric_exporter = OTLPMetricExporter(
        endpoint=f"{base_endpoint}/v1/metrics",
        timeout=_DEFAULT_EXPORT_TIMEOUT_MILLIS / 1_000,
    )
    log_exporter = OTLPLogExporter(
        endpoint=f"{base_endpoint}/v1/logs",
        timeout=_DEFAULT_EXPORT_TIMEOUT_MILLIS / 1_000,
    )
    return (
        BatchSpanProcessor(
            span_exporter,
            max_queue_size=512,
            max_export_batch_size=128,
            schedule_delay_millis=5_000,
            export_timeout_millis=_DEFAULT_EXPORT_TIMEOUT_MILLIS,
        ),
        PeriodicExportingMetricReader(
            metric_exporter,
            export_interval_millis=5_000,
            export_timeout_millis=_DEFAULT_EXPORT_TIMEOUT_MILLIS,
        ),
        BatchLogRecordProcessor(
            log_exporter,
            max_queue_size=512,
            max_export_batch_size=128,
            schedule_delay_millis=5_000,
            export_timeout_millis=_DEFAULT_EXPORT_TIMEOUT_MILLIS,
        ),
    )


def _install_safe_exporter_diagnostics() -> None:
    global _EXPORTER_FILTER_INSTALLED
    with _EXPORTER_FILTER_LOCK:
        for logger_name in _EXPORTER_LOGGERS:
            logger = logging.getLogger(logger_name)
            if _EXPORTER_FILTER_INSTALLED:
                logger.removeFilter(_SAFE_EXPORTER_DIAGNOSTIC_FILTER)
        _SAFE_EXPORTER_DIAGNOSTIC_FILTER.reset()
        for logger_name in _EXPORTER_LOGGERS:
            logging.getLogger(logger_name).addFilter(_SAFE_EXPORTER_DIAGNOSTIC_FILTER)
        _EXPORTER_FILTER_INSTALLED = True


def _emit_diagnostic(diagnostic: Callable[[str], None] | None) -> None:
    try:
        if diagnostic is None:
            logging.getLogger("cso_observability").error("telemetry.unavailable")
        else:
            diagnostic("telemetry.unavailable")
    except Exception:  # noqa: BLE001 - diagnostics must not abort app startup
        return


def _validated_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("telemetry endpoint must be loopback HTTP without credentials")
    path = parsed.path.rstrip("/")
    return urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def _safe_resource_value(value: str, field_name: str) -> str:
    if not _SAFE_RESOURCE_VALUE.fullmatch(value):
        raise ValueError(f"{field_name} must be a bounded safe value")
    return value


def _safe_method(value: Any) -> str:
    if isinstance(value, str) and value in {
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT",
    }:
        return value
    return "OTHER"


def _route_template(scope: Mapping[str, Any]) -> str:
    route = scope.get("route")
    path = getattr(route, "path", None)
    if isinstance(path, str) and path.startswith("/") and len(path) <= 128:
        return path
    return "unmatched"


def _outcome(status_code: int) -> str:
    if status_code >= 500:
        return "server_error"
    if status_code >= 400:
        return "client_error"
    return "success"


def _extract_parent(scope: Mapping[str, Any]) -> Context:
    traceparent = None
    for raw_name, raw_value in scope.get("headers", ()):  # ASGI bytes by contract
        if raw_name.lower() == b"traceparent" and len(raw_value) <= 128:
            try:
                traceparent = raw_value.decode("ascii")
            except UnicodeDecodeError:
                traceparent = None
            break
    if traceparent is None:
        return Context()
    return TraceContextTextMapPropagator().extract(
        {"traceparent": traceparent},
        getter=_TraceParentGetter(),
    )
