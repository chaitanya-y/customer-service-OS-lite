import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { buildApp } from '../src/app.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import { TEST_CONTEXT_ASSERTION, verifyTestContextAssertion } from './trusted-context-fixture.js';

function makeTelemetry() {
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(),
    exportIntervalMillis: 10,
  });
  const logRecordProcessor = new SimpleLogRecordProcessor({ exporter: logs });
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    serviceVersion: '0.1.0',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader,
    logRecordProcessor,
  });
  return { telemetry, spans, logs, logRecordProcessor };
}

test('real hijacked MCP HTTP responses complete once under the internal trace parent', async (context) => {
  const { telemetry, spans, logs, logRecordProcessor } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    commerceProvider: { async getOrderByReference() { return null; } },
    verifyContextAssertion: verifyTestContextAssertion,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  context.after(() => app.close());

  const traceId = '11111111111111111111111111111111';
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`),
    {
      requestInit: {
        headers: {
          [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
          traceparent: `00-${traceId}-2222222222222222-01`,
        },
      },
    },
  );
  const client = new Client({ name: 'telemetry-test-client', version: '0.1.0' });
  await client.connect(transport);
  context.after(() => client.close());
  await client.listTools();
  await client.callTool({ name: 'lookup_order', arguments: { orderReference: 'MISSING' } });
  await logRecordProcessor.forceFlush();

  const serverSpans = spans.getFinishedSpans().filter((span) => span.kind === 1);
  assert.equal(serverSpans.length >= 3, true);
  assert.equal(serverSpans.every((span) => span.spanContext().traceId === traceId), true);
  const completionLogs = logs.getFinishedLogRecords().filter((record) => record.body === 'request.completed');
  assert.equal(completionLogs.length, serverSpans.length);
  assert.equal(new Set(completionLogs.map((record) => record.attributes?.['span.id'])).size, serverSpans.length);
  await telemetry.shutdown();
});

test('invalid Gateway trace context becomes a fresh root and does not affect auth', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    commerceProvider: { async getOrderByReference() { throw new Error('must not be called'); } },
    verifyContextAssertion: verifyTestContextAssertion,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  context.after(() => app.close());

  const response = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      traceparent: 'invalid-CANARY-secret',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup_order', arguments: { orderReference: 'ORDER-123' } } }),
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /context_unauthorized/);
  const span = spans.getFinishedSpans().find((candidate) => candidate.name === 'POST /mcp');
  assert.ok(span);
  assert.equal(span.parentSpanContext, undefined);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('an aborted real HTTP request completes once as a transport error without a response status', async (context) => {
  const { telemetry, spans, logs, logRecordProcessor } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const app = buildApp({
    telemetry,
    commerceProvider: { async getOrderByReference() { return null; } },
    verifyContextAssertion: verifyTestContextAssertion,
  });
  let markHandlerStarted: (() => void) | undefined;
  const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve; });
  app.get('/test-abort', async (request, reply) => {
    reply.hijack();
    markHandlerStarted?.();
    await new Promise<void>((resolve) => request.raw.once('close', resolve));
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  context.after(() => app.close());

  let clientRequest: ReturnType<typeof httpRequest>;
  const requestFailed = new Promise<void>((resolve) => {
    clientRequest = httpRequest(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/test-abort`);
    clientRequest.once('error', () => resolve());
    clientRequest.end();
  });
  await handlerStarted;
  clientRequest!.destroy();
  await requestFailed;
  for (let attempt = 0; attempt < 20 && spans.getFinishedSpans().length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await logRecordProcessor.forceFlush();

  const serverSpans = spans.getFinishedSpans().filter((span) => span.name === 'GET /test-abort');
  assert.equal(serverSpans.length, 1);
  assert.equal(serverSpans[0]?.status.code, 2);
  assert.equal(serverSpans[0]?.attributes.outcome, 'server_error');
  assert.equal(serverSpans[0]?.attributes['error.type'], 'transport_error');
  assert.equal('http.response.status_code' in (serverSpans[0]?.attributes ?? {}), false);
  const completionLogs = logs.getFinishedLogRecords().filter((record) => record.body === 'request.completed');
  assert.equal(completionLogs.length, 1);
  await telemetry.shutdown();
});
