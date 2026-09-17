import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { InMemoryMetricExporter, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { initializeTelemetry } from '@cso/observability-node';

import { createVendureCommerceProvider } from '../src/vendure-client.js';

function makeTelemetry() {
  const spans = new InMemorySpanExporter();
  const telemetry = initializeTelemetry({
    serviceName: 'integration-gateway',
    environment: 'test',
    enabled: true,
    spanProcessor: new SimpleSpanProcessor(spans),
    metricReader: new PeriodicExportingMetricReader({ exporter: new InMemoryMetricExporter(), exportIntervalMillis: 10 }),
    logRecordProcessor: new SimpleLogRecordProcessor({ exporter: new InMemoryLogRecordExporter() }),
  });
  return { telemetry, spans };
}

test('Vendure provider authenticates and maps an order with a safe fallback for an empty fulfillment method', async () => {
  let capturedRequest: RequestInit | undefined;

  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher(_input, init) {
      capturedRequest = init;

      return new Response(
        JSON.stringify({
          data: {
            orders: {
              totalItems: 1,
              items: [
                {
                  id: '3',
                  code: 'ORDER-123',
                  state: 'Delivered',
                  active: false,
                  currencyCode: 'USD',
                  orderPlacedAt: '2026-07-25T23:59:40.265Z',
                  totalWithTax: 168_880,
                  customer: {
                    id: '2',
                    firstName: 'Siva',
                    lastName: 'Kumar',
                    emailAddress: 'siva@example.com',
                  },
                  lines: [
                    {
                      id: '3',
                      quantity: 1,
                      unitPriceWithTax: 167_880,
                      linePriceWithTax: 167_880,
                      productVariant: {
                        id: '2',
                        sku: 'LAPTOP-15',
                        name: 'Laptop 15 inch',
                      },
                    },
                  ],
                  payments: [
                    {
                      id: '2',
                      state: 'Settled',
                      amount: 168_880,
                      method: 'standard-payment',
                      transactionId: 'transaction-123',
                      refunds: [
                        {
                          id: 'refund-1',
                          state: 'Settled',
                          total: 10_000,
                          lines: [
                            {
                              orderLineId: '3',
                            },
                          ],
                        },
                      ],
                    },
                  ],
                  fulfillments: [
                    {
                      id: '2',
                      state: 'Delivered',
                      method: '',
                      trackingCode: 'TRACK-123',
                    },
                  ],
                },
              ],
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    },
  });

  const order = await commerceProvider.getOrderByReference('ORDER-123');

  assert.ok(capturedRequest);
  assert.equal(
    new Headers(capturedRequest.headers).get('vendure-api-key'),
    'test-api-key',
  );
  assert.deepEqual(order, {
    source: {
      provider: 'vendure',
      orderId: '3',
    },
    reference: 'ORDER-123',
    status: 'Delivered',
    active: false,
    placedAt: '2026-07-25T23:59:40.265Z',
    customer: {
      id: '2',
      name: 'Siva Kumar',
      email: 'siva@example.com',
    },
    total: {
      amountMinor: 168_880,
      currency: 'USD',
    },
    items: [
      {
        id: '3',
        sku: 'LAPTOP-15',
        name: 'Laptop 15 inch',
        quantity: 1,
        unitPrice: {
          amountMinor: 167_880,
          currency: 'USD',
        },
        lineTotal: {
          amountMinor: 167_880,
          currency: 'USD',
        },
      },
    ],
    payments: [
      {
        id: '2',
        status: 'Settled',
        amount: {
          amountMinor: 168_880,
          currency: 'USD',
        },
        method: 'standard-payment',
        transactionReference: 'transaction-123',
        refunds: [
          {
            id: 'refund-1',
            status: 'Settled',
            amount: {
              amountMinor: 10_000,
              currency: 'USD',
            },
            lineIds: ['3'],
          },
        ],
      },
    ],
    fulfillments: [
      {
        id: '2',
        status: 'Delivered',
        method: 'unspecified',
        trackingCode: 'TRACK-123',
      },
    ],
  });
});

test('Vendure provider returns null when the order does not exist', async () => {
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher() {
      return Response.json({
        data: {
          orders: {
            totalItems: 0,
            items: [],
          },
        },
      });
    },
  });

  const order = await commerceProvider.getOrderByReference('MISSING');

  assert.equal(order, null);
});

test('Vendure provider looks up an internal order ID with the order query', async () => {
  let capturedRequest: RequestInit | undefined;
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'test-api-key',
    async fetcher(_input, request) {
      capturedRequest = request;
      return Response.json({ data: { order: null } });
    },
  });

  const order = await commerceProvider.getOrderById('3');

  assert.equal(order, null);
  assert.ok(capturedRequest);
  const body = JSON.parse(String(capturedRequest.body));
  assert.deepEqual(body.variables, { id: '3' });
  assert.match(body.query, /order\(id: \$id\)/);
});

test('Vendure order lookup emits a static successful child span without forwarding trace context', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  let capturedHeaders = new Headers();
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher(_input, request) {
      capturedHeaders = new Headers(request?.headers);
      return Response.json({ data: { orders: { totalItems: 0, items: [] } } });
    },
  });

  assert.equal(await commerceProvider.getOrderByReference('MISSING'), null);
  assert.equal(capturedHeaders.get('vendure-api-key'), 'CANARY-api-key');
  assert.equal(capturedHeaders.get('traceparent'), null);
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.name, 'vendure.order_lookup');
  assert.equal(span.attributes['http.response.status_code'], 200);
  assert.equal(span.status.code, 0);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure HTTP 200 GraphQL errors are safe application errors in telemetry', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      return Response.json({ errors: [{ message: 'CANARY-provider-error' }] });
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), /GraphQL error/);
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['http.response.status_code'], 200);
  assert.equal(span.attributes['error.type'], 'application_error');
  assert.equal(span.status.code, 2);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure order lookup timeouts use a fixed safe timeout category', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      throw new DOMException('CANARY-timeout-detail', 'TimeoutError');
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), { name: 'TimeoutError' });
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['error.type'], 'timeout');
  assert.equal(span.status.code, 2);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});

test('Vendure response body timeouts remain timeout errors', async (context) => {
  const { telemetry, spans } = makeTelemetry();
  context.after(() => telemetry.shutdown());
  const commerceProvider = createVendureCommerceProvider({
    adminApiUrl: 'http://vendure.test/admin-api',
    apiKey: 'CANARY-api-key',
    telemetry,
    async fetcher() {
      return {
        ok: true,
        status: 200,
        async json() { throw new DOMException('CANARY-body-timeout', 'TimeoutError'); },
      } as Response;
    },
  });

  await assert.rejects(() => commerceProvider.getOrderByReference('CANARY-order'), { name: 'TimeoutError' });
  const span = spans.getFinishedSpans()[0];
  assert.equal(span.attributes['error.type'], 'timeout');
  assert.equal('http.response.status_code' in span.attributes, false);
  assert.equal(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status }).includes('CANARY'), false);
  await telemetry.shutdown();
});
