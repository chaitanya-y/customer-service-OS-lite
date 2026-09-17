import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { buildApp } from '../src/app.js';
import {
  createTestConversationService,
  FakeConversationRepository,
  TEST_CONTEXT,
  TEST_CONVERSATION_ID,
  TEST_SERVICE_CONTEXT,
} from './test-fixtures.js';

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
    serviceName: 'conversation-runtime',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader,
    logRecordProcessor,
  });
  return { telemetry, spans, logs, metrics, metricReader, logRecordProcessor };
}

test('message persistence failure records only the static route, bounded outcome, and fixed telemetry log', async (context) => {
  const { telemetry, spans, logs, metrics, metricReader, logRecordProcessor } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const repository = new FakeConversationRepository();
  repository.messageError = new Error('CANARY raw persistence failure');
  const app = buildApp({
    telemetry,
    verifyContextAssertion: async () => TEST_CONTEXT,
    verifyServiceAssertion: async () => TEST_SERVICE_CONTEXT,
    conversationService: createTestConversationService(repository),
    checkHealth: async () => undefined,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${TEST_CONVERSATION_ID}/messages?token=CANARY`,
    headers: {
      'x-cso-context-assertion': 'CANARY signed assertion',
      'idempotency-key': 'message-CANARY',
      traceparent: 'invalid-CANARY-traceparent',
    },
    payload: {
      clientMessageId: 'message-CANARY',
      content: { type: 'text', text: 'CANARY customer message' },
    },
  });
  await metricReader.forceFlush();
  await logRecordProcessor.forceFlush();

  assert.equal(response.statusCode, 500);
  const span = spans.getFinishedSpans().find((candidate) => candidate.name === 'POST /v1/conversations/:conversationId/messages');
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
