import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { createAgentRuntimeClient } from '../src/agent-runtime-client.js';
import { buildApp } from '../src/app.js';
import { closeFastifyWithin, shutdownWithTelemetry } from '../src/observability.js';

test('Edge replaces public trace context and propagates its own context only to Agent Runtime', async (context) => {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter();
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    logRecordProcessor: new SimpleLogRecordProcessor({ exporter: logs }),
    metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 10 }),
  });
  context.after(() => telemetry.shutdown());

  let propagatedTraceparent = '';
  const client = createAgentRuntimeClient({
    baseUrl: 'http://127.0.0.1:8000',
    telemetry,
    fetchImpl: async (_input, init) => {
      propagatedTraceparent = new Headers(init?.headers).get('traceparent') ?? '';
      return Response.json({ status: 'ok' });
    },
  });
  const correlationIds: string[] = [];
  const app = buildApp({
    telemetry,
    verifyCustomerIdentity: async () => ({ principalId: 'customer-1', tenantId: 'tenant-1', environmentId: 'test', customerId: 'customer-1' }),
    signContextAssertion: async ({ traceId }) => { correlationIds.push(traceId); return 'gateway'; },
    signAgentRuntimeContextAssertion: async ({ traceId }) => { correlationIds.push(traceId); return 'agent'; },
    signKnowledgeRagContextAssertion: async ({ traceId }) => { correlationIds.push(traceId); return 'rag'; },
    intakeRefund: client.intakeRefund,
  });
  context.after(() => app.close());

  const incomingTraceId = '11111111111111111111111111111111';
  const response = await app.inject({
    method: 'POST',
    url: '/v1/refunds/intake?secret=CANARY',
    headers: {
      authorization: 'Bearer CANARY',
      traceparent: `00-${incomingTraceId}-2222222222222222-01`,
      baggage: 'secret=CANARY',
    },
    payload: { customer_message: 'CANARY customer content' },
  });

  assert.equal(response.statusCode, 200);
  assert.match(propagatedTraceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  assert.notEqual(propagatedTraceparent.slice(3, 35), incomingTraceId);
  assert.equal(correlationIds.every((value) => /^[0-9a-f-]{36}$/.test(value)), true);
  assert.equal(correlationIds.includes(propagatedTraceparent.slice(3, 35)), false);
  const serialized = JSON.stringify({
    spans: spans.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status })),
    logs: logs.getFinishedLogRecords().map((record) => ({ body: record.body, attributes: record.attributes })),
    metrics: metrics.getMetrics().resourceMetrics?.scopeMetrics,
  });
  assert.equal(serialized.includes('CANARY'), false);
  assert.equal(spans.getFinishedSpans().some((span) => span.name === 'POST /v1/refunds/intake'), true);
  assert.equal(spans.getFinishedSpans().some((span) => span.name === 'agent-runtime'), true);
  await telemetry.shutdown();
});

test('invalid traceparent cannot influence a health request and creates no exception events', async (context) => {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter();
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    logRecordProcessor: new SimpleLogRecordProcessor({ exporter: logs }),
    metricReader: new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 10 }),
  });
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    verifyCustomerIdentity: async () => { throw new Error('unused'); },
    signContextAssertion: async () => 'unused',
    signAgentRuntimeContextAssertion: async () => 'unused',
    signKnowledgeRagContextAssertion: async () => 'unused',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health?secret=CANARY', headers: { traceparent: 'invalid-CANARY' } });

  assert.equal(response.statusCode, 200);
  assert.equal(spans.getFinishedSpans()[0].events.length, 0);
  assert.equal(JSON.stringify(spans.getFinishedSpans().map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
  }))).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('an unavailable collector does not change the HTTP result and shutdown stays bounded', async (context) => {
  const diagnostics: string[] = [];
  const telemetry = initializeTelemetry({
    serviceName: 'edge-api',
    environment: 'test',
    enabled: true,
    endpoint: 'http://127.0.0.1:1',
    shutdownTimeoutMilliseconds: 1_500,
    diagnostic: (message) => diagnostics.push(message),
  });
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    verifyCustomerIdentity: async () => { throw new Error('unused'); },
    signContextAssertion: async () => 'unused',
    signAgentRuntimeContextAssertion: async () => 'unused',
    signKnowledgeRagContextAssertion: async () => 'unused',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
  });
  context.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/health' });
  const started = performance.now();
  await telemetry.shutdown();

  assert.equal(response.statusCode, 200);
  assert.equal(performance.now() - started < 2_000, true);
  assert.deepEqual(diagnostics, ['telemetry.unavailable']);
});

test('shutdown force-closes a real SSE stream and always shuts down telemetry', async (context) => {
  const app = buildApp({
    verifyCustomerIdentity: async () => ({ principalId: 'customer-1', tenantId: 'tenant-1', environmentId: 'test', customerId: 'customer-1' }),
    signContextAssertion: async () => 'unused',
    signAgentRuntimeContextAssertion: async () => 'unused',
    signKnowledgeRagContextAssertion: async () => 'unused',
    intakeRefund: async () => ({ statusCode: 200, body: {} }),
    getRefundWorkflow: async () => ({ stage: 'AWAITING_CUSTOMER_CONFIRMATION' }) as never,
    refundJourneyPollIntervalMilliseconds: 10_000,
  });
  context.after(() => app.close().catch(() => undefined));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const response = await fetch(`http://127.0.0.1:${(address as { port: number }).port}/v1/refunds/refund-1/events`, {
    headers: { authorization: 'Bearer synthetic' },
  });
  assert.equal(response.status, 200);
  await response.body?.getReader().read();

  let telemetryStopped = false;
  const started = performance.now();
  await shutdownWithTelemetry({
    closeServer: () => closeFastifyWithin(app, 500),
    shutdownTelemetry: async () => { telemetryStopped = true; },
    timeoutMilliseconds: 750,
  });

  assert.equal(performance.now() - started < 1_500, true);
  assert.equal(telemetryStopped, true);
});

test('telemetry shutdown still runs when server teardown never settles', async () => {
  let telemetryStopped = false;
  const started = performance.now();

  await shutdownWithTelemetry({
    closeServer: () => new Promise<void>(() => {}),
    shutdownTelemetry: async () => { telemetryStopped = true; },
    timeoutMilliseconds: 25,
  });

  assert.equal(performance.now() - started < 250, true);
  assert.equal(telemetryStopped, true);
});
