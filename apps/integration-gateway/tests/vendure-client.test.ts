import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createVendureCommerceProvider } from '../src/vendure-client.js';

test('Vendure provider authenticates and maps an order', async () => {
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
                    },
                  ],
                  fulfillments: [
                    {
                      id: '2',
                      state: 'Delivered',
                      method: 'Test Courier',
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
      },
    ],
    fulfillments: [
      {
        id: '2',
        status: 'Delivered',
        method: 'Test Courier',
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
