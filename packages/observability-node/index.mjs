import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator, setGlobalErrorHandler } from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
} from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, BasicTracerProvider } from '@opentelemetry/sdk-trace-base';

const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_SERVER_OPERATION = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) \/[A-Za-z0-9_/:.-]{0,100}$/;
const SAFE_CLIENT_OPERATION = /^[a-z][a-z0-9._-]{0,79}$/;
const SAFE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
const SAFE_ERROR_CATEGORIES = new Set(['application_error', 'transport_error', 'timeout']);
const SAFE_ACTIVITY_OPERATIONS = new Set([
  'temporal.activity.refund_context_refresh',
  'temporal.activity.refund_policy_evaluation',
  'temporal.activity.refund_preview_create',
  'temporal.activity.human_case_open',
  'temporal.activity.human_case_close',
  'temporal.activity.refund_confirmation_handle',
  'temporal.activity.refund_submission',
  'temporal.activity.refund_reconciliation',
  'temporal.activity.refund_evidence_open',
  'temporal.activity.refund_evidence_read',
  'temporal.activity.refund_evidence_transition',
  'temporal.activity.refund_evidence_close',
]);
const SAFE_ACTIVITY_DEPENDENCIES = new Set(['integration_gateway', 'human_operations']);
const SAFE_ACTIVITY_OUTCOMES = new Set([
  'success',
  'submitted',
  'succeeded',
  'failed',
  'pending_reconciliation',
  'processing',
  'not_found',
]);
const propagator = new W3CTraceContextPropagator();
const traceparentGetter = {
  get(carrier, key) {
    return key === 'traceparent' ? carrier.traceparent : undefined;
  },
  keys() {
    return ['traceparent'];
  },
};

let singleton;

function safeValue(value, fallback) {
  return typeof value === 'string' && SAFE_VALUE.test(value) ? value : fallback;
}

function validateEndpoint(value) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
    if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.search || url.hash) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function endpointFor(base, signal) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${signal}`;
  return url.toString();
}

function outcomeFor(statusCode) {
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  return 'success';
}

function boundedShutdown(promises, timeoutMilliseconds) {
  return Promise.race([
    Promise.allSettled(promises).then(() => undefined),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMilliseconds);
      timer.unref?.();
    }),
  ]);
}

function disabledHandle(diagnostic) {
  let stopped = false;
  return {
    enabled: false,
    startServerRequest(_input, continueRequest) {
      continueRequest();
      return { end() {} };
    },
    async withClientRequest(_input, headers, request) {
      return request(new Headers(headers));
    },
    async withActivity(_input, activity) {
      return activity();
    },
    async shutdown() {
      if (stopped) return;
      stopped = true;
      if (singleton === this) singleton = undefined;
    },
    diagnostic,
  };
}

export function initializeTelemetry(options) {
  if (singleton) return singleton;

  const enabled = options.enabled ?? process.env.CSO_TELEMETRY_ENABLED === 'true';
  if (!enabled) {
    singleton = disabledHandle();
    return singleton;
  }

  const diagnostic = options.diagnostic ?? (() => console.error('telemetry.unavailable'));
  const endpoint = validateEndpoint(options.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://127.0.0.1:4318');
  if (!endpoint) {
    diagnostic('telemetry.unavailable');
    singleton = disabledHandle(diagnostic);
    return singleton;
  }

  try {
    const serviceName = safeValue(options.serviceName ?? process.env.OTEL_SERVICE_NAME, 'unknown-service');
    const serviceVersion = safeValue(options.serviceVersion ?? process.env.OTEL_SERVICE_VERSION, 'unknown');
    const environment = safeValue(options.environment ?? process.env.ENVIRONMENT_ID, 'local');
    let lastDiagnosticAt = 0;
    setGlobalErrorHandler(() => {
      const now = Date.now();
      if (now - lastDiagnosticAt < 60_000) return;
      lastDiagnosticAt = now;
      diagnostic('telemetry.unavailable');
    });
    const resource = resourceFromAttributes({
      'service.name': serviceName,
      'service.version': serviceVersion,
      'deployment.environment.name': environment,
    });
    const spanProcessor = options.spanProcessor ?? new BatchSpanProcessor(
      new OTLPTraceExporter({ url: endpointFor(endpoint, 'traces'), timeoutMillis: 1_000 }),
      { maxQueueSize: 256, maxExportBatchSize: 64, scheduledDelayMillis: 500, exportTimeoutMillis: 1_000 },
    );
    const metricReader = options.metricReader ?? new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: endpointFor(endpoint, 'metrics'), timeoutMillis: 1_000 }),
      exportIntervalMillis: 5_000,
      exportTimeoutMillis: 1_000,
    });
    const logRecordProcessor = options.logRecordProcessor ?? new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: endpointFor(endpoint, 'logs'), timeoutMillis: 1_000 }),
      maxQueueSize: 256,
      maxExportBatchSize: 64,
      scheduledDelayMillis: 500,
      exportTimeoutMillis: 1_000,
    });
    const tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
      spanLimits: { attributeCountLimit: 12, attributeValueLengthLimit: 120, eventCountLimit: 0, linkCountLimit: 0 },
    });
    const safeMetricAttributes = createAllowListAttributesProcessor([
      'operation',
      'outcome',
      'http.response.status_code',
    ]);
    const meterProvider = new MeterProvider({
      resource,
      readers: [metricReader],
      views: [
        {
          instrumentName: 'cso.operation.completed',
          attributesProcessors: [safeMetricAttributes],
          aggregationCardinalityLimit: 256,
        },
        {
          instrumentName: 'cso.operation.duration',
          attributesProcessors: [safeMetricAttributes],
          aggregationCardinalityLimit: 256,
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: {
              boundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
            },
          },
        },
      ],
    });
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [logRecordProcessor],
      logRecordLimits: { attributeCountLimit: 12, attributeValueLengthLimit: 120 },
    });
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    const tracer = tracerProvider.getTracer('@cso/observability-node');
    const meter = meterProvider.getMeter('@cso/observability-node');
    const logger = loggerProvider.getLogger('@cso/observability-node');
    const completed = meter.createCounter('cso.operation.completed');
    const duration = meter.createHistogram('cso.operation.duration', { unit: 's' });
    let stopped = false;

    singleton = {
      enabled: true,
      startServerRequest(input, continueRequest) {
        const operation = SAFE_SERVER_OPERATION.test(input.operation) ? input.operation : 'unmatched';
        const method = SAFE_METHODS.has(input.method) ? input.method : 'UNKNOWN';
        const started = process.hrtime.bigint();
        const parentContext = typeof input.traceparent === 'string'
          ? propagator.extract(ROOT_CONTEXT, { traceparent: input.traceparent }, traceparentGetter)
          : ROOT_CONTEXT;
        const span = tracer.startSpan(operation, {
          kind: SpanKind.SERVER,
          attributes: { operation, 'http.request.method': method },
        }, parentContext);
        const activeContext = trace.setSpan(ROOT_CONTEXT, span);
        let ended = false;
        context.with(activeContext, continueRequest);
        return {
          end(result) {
            if (ended) return;
            ended = true;
            const statusCode = result.statusCode === undefined
              ? undefined
              : Number.isInteger(result.statusCode) && result.statusCode >= 100 && result.statusCode <= 599
                ? result.statusCode
                : 500;
            const outcome = statusCode === undefined ? 'server_error' : outcomeFor(statusCode);
            const attributes = {
              operation,
              outcome,
              ...(statusCode === undefined ? {} : { 'http.response.status_code': statusCode }),
            };
            span.setAttributes(attributes);
            if (outcome === 'server_error') span.setStatus({ code: SpanStatusCode.ERROR });
            if (result.errorCategory) {
              span.setAttribute('error.type', SAFE_ERROR_CATEGORIES.has(result.errorCategory) ? result.errorCategory : 'application_error');
            }
            completed.add(1, attributes, activeContext);
            duration.record(Number(process.hrtime.bigint() - started) / 1e9, attributes, activeContext);
            const spanContext = span.spanContext();
            logger.emit({
              severityNumber: SeverityNumber.INFO,
              severityText: 'INFO',
              body: 'request.completed',
              attributes: { ...attributes, 'trace.id': spanContext.traceId, 'span.id': spanContext.spanId },
              context: activeContext,
            });
            span.end();
          },
        };
      },
      async withClientRequest(input, headers, request) {
        const operation = SAFE_CLIENT_OPERATION.test(input.operation) ? input.operation : 'internal-dependency';
        const method = SAFE_METHODS.has(input.method) ? input.method : 'UNKNOWN';
        return tracer.startActiveSpan(operation, {
          kind: SpanKind.CLIENT,
          attributes: { operation, 'dependency.name': operation, 'http.request.method': method },
        }, async (span) => {
          const outgoing = new Headers(headers);
          if (input.propagate !== false) {
            propagator.inject(context.active(), outgoing, { set(carrier, key, value) { carrier.set(key, value); } });
          }
          try {
            const response = await request(outgoing);
            span.setAttribute('http.response.status_code', response.status);
            if (response.status >= 500 || response.telemetryError === 'application_error') {
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
            if (response.telemetryError === 'application_error') {
              span.setAttribute('error.type', 'application_error');
            }
            return response;
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            const errorName = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
            span.setAttribute('error.type', errorName === 'AbortError' || errorName === 'TimeoutError' ? 'timeout' : 'transport_error');
            throw error;
          } finally {
            span.end();
          }
        });
      },
      async withActivity(input, activity) {
        const operation = SAFE_ACTIVITY_OPERATIONS.has(input.operation)
          ? input.operation
          : 'temporal.activity.unknown';
        const dependency = SAFE_ACTIVITY_DEPENDENCIES.has(input.dependency)
          ? input.dependency
          : undefined;
        return tracer.startActiveSpan(operation, {
          kind: SpanKind.INTERNAL,
          attributes: {
            operation,
            ...(dependency === undefined ? {} : { 'dependency.name': dependency }),
          },
        }, async (span) => {
          try {
            const result = await activity();
            const classifiedOutcome = input.outcome?.(result);
            const outcome = SAFE_ACTIVITY_OUTCOMES.has(classifiedOutcome)
              ? classifiedOutcome
              : 'success';
            span.setAttribute('outcome', outcome);
            return result;
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            const errorName = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
            span.setAttribute('error.type', errorName === 'AbortError' || errorName === 'TimeoutError' ? 'timeout' : 'application_error');
            throw error;
          } finally {
            span.end();
          }
        });
      },
      async shutdown() {
        if (stopped) return;
        stopped = true;
        await boundedShutdown([
          tracerProvider.shutdown(),
          meterProvider.shutdown({ timeoutMillis: 1_000 }),
          loggerProvider.shutdown({ timeoutMillis: 1_000 }),
        ], options.shutdownTimeoutMilliseconds ?? 1_500);
        contextManager.disable();
        context.disable();
        if (singleton === this) singleton = undefined;
      },
    };
    return singleton;
  } catch {
    diagnostic('telemetry.unavailable');
    singleton = disabledHandle(diagnostic);
    return singleton;
  }
}
