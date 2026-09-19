import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

import { initializeTelemetry } from '../index.mjs';

function makeExporters() {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter();
  const logs = new InMemoryLogRecordExporter();
  return {
    spans,
    metrics,
    logs,
    options: {
      spanProcessor: new SimpleSpanProcessor(spans),
      metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 10 }),
      logRecordProcessor: new SimpleLogRecordProcessor({ exporter: logs }),
    },
  };
}

function exportedMetrics(exporter) {
  return exporter.getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .map((metric) => ({
      name: metric.descriptor.name,
      points: metric.dataPoints.map((point) => ({
        value: point.value,
        attributes: point.attributes,
      })),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function operationalGaugeUnits(exporter) {
  return exporter.getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .filter((metric) => metric.descriptor.name.startsWith('cso.') && metric.descriptor.name !== 'cso.operation.completed' && metric.descriptor.name !== 'cso.operation.duration')
    .map((metric) => ({ name: metric.descriptor.name, unit: metric.descriptor.unit }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

test('operational gauges export only the closed names, values, and outcome dimensions', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 11, outcome: 'IN_PROGRESS' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 12, outcome: 'SUBMITTED' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 13, outcome: 'SUCCEEDED' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 14, outcome: 'FAILED' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 15, outcome: 'PENDING_RECONCILIATION' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.oldest_age', value: 21, outcome: 'IN_PROGRESS' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.oldest_age', value: 22, outcome: 'SUBMITTED' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.oldest_age', value: 23, outcome: 'PENDING_RECONCILIATION' });
  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: 31 });
  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.oldest_age', value: 32 });
  telemetry.recordOperationalGauge({ name: 'cso.human_operations.decision_outbox.pending', value: 41 });
  telemetry.recordOperationalGauge({ name: 'cso.human_operations.decision_outbox.oldest_age', value: 42 });
  await exporters.options.metricReader.forceFlush();

  assert.deepEqual(exportedMetrics(exporters.metrics), [
    { name: 'cso.human_operations.decision_outbox.oldest_age', points: [{ value: 42, attributes: {} }] },
    { name: 'cso.human_operations.decision_outbox.pending', points: [{ value: 41, attributes: {} }] },
    {
      name: 'cso.refund.executions.current',
      points: [
        { value: 11, attributes: { outcome: 'IN_PROGRESS' } },
        { value: 12, attributes: { outcome: 'SUBMITTED' } },
        { value: 13, attributes: { outcome: 'SUCCEEDED' } },
        { value: 14, attributes: { outcome: 'FAILED' } },
        { value: 15, attributes: { outcome: 'PENDING_RECONCILIATION' } },
      ],
    },
    {
      name: 'cso.refund.executions.oldest_age',
      points: [
        { value: 21, attributes: { outcome: 'IN_PROGRESS' } },
        { value: 22, attributes: { outcome: 'SUBMITTED' } },
        { value: 23, attributes: { outcome: 'PENDING_RECONCILIATION' } },
      ],
    },
    { name: 'cso.refund.provider_events.oldest_age', points: [{ value: 32, attributes: {} }] },
    { name: 'cso.refund.provider_events.pending', points: [{ value: 31, attributes: {} }] },
    { name: 'cso.telemetry.heartbeat', points: [{ value: 1, attributes: {} }] },
  ]);
  assert.deepEqual(operationalGaugeUnits(exporters.metrics), [
    { name: 'cso.human_operations.decision_outbox.oldest_age', unit: 's' },
    { name: 'cso.human_operations.decision_outbox.pending', unit: '' },
    { name: 'cso.refund.executions.current', unit: '' },
    { name: 'cso.refund.executions.oldest_age', unit: 's' },
    { name: 'cso.refund.provider_events.oldest_age', unit: 's' },
    { name: 'cso.refund.provider_events.pending', unit: '' },
    { name: 'cso.telemetry.heartbeat', unit: '' },
  ]);
});

test('operational gauges ignore invalid observations and canary identifiers', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.unknown', value: 1 });
  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: Number.NaN });
  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: Infinity });
  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: -1 });
  telemetry.recordOperationalGauge({ name: 'cso.refund.executions.current', value: 2, outcome: 'CANARY-customer-identifier' });
  await exporters.options.metricReader.forceFlush();

  const metrics = exportedMetrics(exporters.metrics);
  assert.deepEqual(metrics, [
    { name: 'cso.telemetry.heartbeat', points: [{ value: 1, attributes: {} }] },
  ]);
  assert.equal(JSON.stringify(metrics).includes('CANARY'), false);
});

test('disabled telemetry ignores operational gauges', async () => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({ serviceName: 'integration-gateway', enabled: false, ...exporters.options });

  telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: 1 });
  await exporters.options.metricReader.forceFlush();
  await telemetry.shutdown();

  assert.deepEqual(exportedMetrics(exporters.metrics), []);
});

test('disabled initialization is idempotent and does not export', async () => {
  const exporters = makeExporters();
  const first = initializeTelemetry({ serviceName: 'edge-api', enabled: false, ...exporters.options });
  const second = initializeTelemetry({ serviceName: 'ignored', enabled: false, ...exporters.options });

  assert.equal(first, second);
  assert.equal(first.enabled, false);
  const request = first.startServerRequest({ operation: 'GET /health', method: 'GET' }, () => {});
  request.end({ statusCode: 200 });
  await first.shutdown();

  assert.deepEqual(exporters.spans.getFinishedSpans(), []);
  assert.deepEqual(exporters.logs.getFinishedLogRecords(), []);
});

test('exports only bounded allowlisted request fields and fixed log text', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    serviceVersion: '0.1.0',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const secret = 'CANARY-auth-query-customer-message-raw-exception';
  const request = telemetry.startServerRequest(
    { operation: `GET /health?secret=${secret}`, method: `GET ${secret}` },
    () => {},
  );
  request.end({ statusCode: 503, errorCategory: `failure-${secret}` });
  await exporters.options.logRecordProcessor.forceFlush();
  await exporters.options.metricReader.forceFlush();

  const serialized = JSON.stringify({
    spans: exporters.spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })),
    logs: exporters.logs.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    metrics: exporters.metrics.getMetrics().resourceMetrics?.scopeMetrics,
  });
  assert.equal(serialized.includes(secret), false);
  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.name, 'unmatched');
  assert.equal(span.events.length, 0);
  assert.equal(span.status.message, undefined);
  assert.equal(span.attributes['error.type'], 'application_error');
  assert.equal('error.category' in span.attributes, false);
  assert.equal(exporters.logs.getFinishedLogRecords()[0].body, 'request.completed');
  const durationMetric = exporters.metrics.getMetrics()[0].scopeMetrics[0].metrics.find(
    (metric) => metric.descriptor.name === 'cso.operation.duration',
  );
  assert.deepEqual(durationMetric.dataPoints[0].value.buckets.boundaries, [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
  ]);
  await telemetry.shutdown();
});

test('invalid local collector configuration degrades safely without exporting', async () => {
  const diagnostics = [];
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    enabled: true,
    endpoint: 'https://collector.example.test/path?token=CANARY',
    diagnostic: (message) => diagnostics.push(message),
  });

  assert.equal(telemetry.enabled, false);
  assert.deepEqual(diagnostics, ['telemetry.unavailable']);
  await telemetry.shutdown();
});

test('accepts an IPv6 loopback collector endpoint', async () => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    enabled: true,
    endpoint: 'http://[::1]:4318',
    ...exporters.options,
  });

  assert.equal(telemetry.enabled, true);
  await telemetry.shutdown();
});

test('inherits only a valid explicitly supplied W3C trace parent', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const inheritedTraceId = '11111111111111111111111111111111';
  const request = telemetry.startServerRequest({
    operation: 'POST /mcp',
    method: 'POST',
    traceparent: `00-${inheritedTraceId}-2222222222222222-01`,
  }, () => {});
  request.end({ statusCode: 200 });

  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.spanContext().traceId, inheritedTraceId);
  assert.equal(span.parentSpanContext?.spanId, '2222222222222222');
  await telemetry.shutdown();
});

test('invalid explicitly supplied trace context starts a new root without leaking the value', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const request = telemetry.startServerRequest({
    operation: 'GET /health',
    method: 'GET',
    traceparent: 'invalid-CANARY-secret',
  }, () => {});
  request.end({ statusCode: 200 });

  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.parentSpanContext, undefined);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('client observation can preserve provider headers without propagating trace context', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const response = await telemetry.withClientRequest(
    { operation: 'vendure.order_lookup', method: 'POST', propagate: false },
    { 'vendure-api-key': 'CANARY-provider-secret', 'content-type': 'application/json' },
    async (headers) => {
      assert.equal(headers.get('traceparent'), null);
      assert.equal(headers.get('vendure-api-key'), 'CANARY-provider-secret');
      return { status: 200 };
    },
  );

  assert.equal(response.status, 200);
  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.name, 'vendure.order_lookup');
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('a server request without a response status is a transport failure without an invented HTTP status', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const request = telemetry.startServerRequest(
    { operation: 'GET /test-abort', method: 'GET' },
    () => {},
  );
  request.end({ errorCategory: 'transport_error' });

  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.status.code, 2);
  assert.equal(span.attributes.outcome, 'server_error');
  assert.equal(span.attributes['error.type'], 'transport_error');
  assert.equal('http.response.status_code' in span.attributes, false);
  await telemetry.shutdown();
});

test('an activity observation exports only its fixed boundary outcome', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'workflow-workers',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const secret = 'CANARY-customer-order-tenant-token-provider-body';
  const result = await telemetry.withActivity(
    {
      operation: 'temporal.activity.refund_submission',
      dependency: 'integration_gateway',
      outcome: (value) => value.status,
    },
    async () => ({ status: 'submitted', providerBody: secret }),
  );

  assert.deepEqual(result, { status: 'submitted', providerBody: secret });
  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.name, 'temporal.activity.refund_submission');
  assert.deepEqual(span.attributes, {
    operation: 'temporal.activity.refund_submission',
    'dependency.name': 'integration_gateway',
    outcome: 'submitted',
  });
  assert.equal(span.events.length, 0);
  assert.equal(span.status.message, undefined);
  assert.equal(JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status }).includes(secret), false);
  assert.deepEqual(exporters.metrics.getMetrics().resourceMetrics?.scopeMetrics ?? [], []);
  await telemetry.shutdown();
});

test('disabled activity observation preserves the activity result without exporting', async () => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'workflow-workers',
    enabled: false,
    ...exporters.options,
  });

  const result = await telemetry.withActivity(
    { operation: 'temporal.activity.refund_context_refresh' },
    async () => 'fresh-context',
  );

  assert.equal(result, 'fresh-context');
  await telemetry.shutdown();
  assert.deepEqual(exporters.spans.getFinishedSpans(), []);
});

test('an activity failure exports a safe error category without exception text', async (context) => {
  const exporters = makeExporters();
  const telemetry = initializeTelemetry({
    serviceName: 'workflow-workers',
    environment: 'test',
    enabled: true,
    ...exporters.options,
  });
  context.after(() => telemetry.shutdown());

  const secret = 'CANARY-customer-order-tenant-token-provider-body';
  const failure = new Error(secret);
  await assert.rejects(
    telemetry.withActivity(
      { operation: 'temporal.activity.refund_reconciliation', dependency: 'integration_gateway' },
      async () => { throw failure; },
    ),
    failure,
  );

  const span = exporters.spans.getFinishedSpans()[0];
  assert.equal(span.status.code, 2);
  assert.equal(span.status.message, undefined);
  assert.deepEqual(span.attributes, {
    operation: 'temporal.activity.refund_reconciliation',
    'dependency.name': 'integration_gateway',
    'error.type': 'application_error',
  });
  assert.equal(span.events.length, 0);
  assert.equal(JSON.stringify({ name: span.name, attributes: span.attributes, events: span.events, status: span.status }).includes(secret), false);
  await telemetry.shutdown();
});
