import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { buildApp, deliverOutbox } from '../src/app.js';

function makeTelemetry() {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter();
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metrics,
    exportIntervalMillis: 10,
  });
  const logRecordProcessor = new SimpleLogRecordProcessor({ exporter: logs });
  const telemetry = initializeTelemetry({
    serviceName: 'human-operations',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader,
    logRecordProcessor,
  });
  return { telemetry, spans, logs, metrics, metricReader, logRecordProcessor };
}

test('staff decision failure records only a static route, outcome, and fixed telemetry log', async (context) => {
  const { telemetry, spans, logs, metrics, metricReader, logRecordProcessor } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    verifyHuman: async () => ({
      staffId: 'staff-CANARY',
      tenantId: 'tenant-CANARY',
      environmentId: 'test',
      role: 'REFUND_APPROVER',
      iss: 'human-operations',
      aud: 'human-operations',
    }),
    sendDecision: async () => { throw new Error('CANARY raw workflow failure'); },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-workflows/workflow-CANARY/decision?token=CANARY',
    headers: {
      'x-cso-human-assertion': 'CANARY signed assertion',
      traceparent: 'invalid-CANARY-traceparent',
    },
    payload: { decision: 'APPROVE', reasonCode: 'CANARY_REASON' },
  });
  await metricReader.forceFlush();
  await logRecordProcessor.forceFlush();

  assert.equal(response.statusCode, 502);
  const span = spans.getFinishedSpans().find((candidate) => candidate.name === 'POST /internal/v1/refund-workflows/:workflowId/decision');
  assert.ok(span);
  assert.equal(span.attributes.outcome, 'server_error');
  assert.equal(span.events.length, 0);
  assert.equal(logs.getFinishedLogRecords().some((record) => record.body === 'request.completed'), true);
  assert.equal(metrics.getMetrics().some((metric) => metric.scopeMetrics[0]?.metrics.some((entry) => entry.descriptor.name === 'cso.operation.duration')), true);
  const serialized = JSON.stringify({
    spans: spans.getFinishedSpans().map((candidate) => ({ name: candidate.name, attributes: candidate.attributes, events: candidate.events, status: candidate.status })),
    logs: logs.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    metrics: metrics.getMetrics(),
  });
  assert.equal(serialized.includes('CANARY'), false);
});

test('failed decision-outbox delivery creates a safe static dependency span', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const delivered = await deliverOutbox(
    async () => { throw new Error('CANARY raw outbox failure'); },
    { markOutboxDelivered: async () => undefined } as never,
    {
      eventId: 'event-CANARY',
      caseId: 'case-CANARY',
      workflowId: 'workflow-CANARY',
      tenantId: 'tenant-CANARY',
      environmentId: 'test',
      decision: 'APPROVE',
      decidedBy: 'staff-CANARY',
      decidedAt: '2026-09-17T12:00:00.000Z',
      note: 'CANARY staff note',
      createdAt: '2026-09-17T12:00:00.000Z',
    },
    telemetry,
  );

  assert.equal(delivered, false);
  const span = spans.getFinishedSpans().find((candidate) => candidate.name === 'human-operations.decision-outbox');
  assert.ok(span);
  assert.equal(span.status.code, 2);
  assert.equal(span.attributes['error.type'], 'application_error');
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
});
