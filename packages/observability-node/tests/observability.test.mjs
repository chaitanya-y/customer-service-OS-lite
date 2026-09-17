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
