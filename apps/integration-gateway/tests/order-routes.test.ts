import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type {
  CommerceOrder,
  CommerceProvider,
} from '../src/commerce.js';

const order: CommerceOrder = {
  source: {
    provider: 'vendure',
    orderId: '3',
  },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: null,
  total: {
    amountMinor: 10_000,
    currency: 'USD',
  },
  items: [],
  payments: [],
  fulfillments: [],
};

test('GET /v1/orders/:reference returns a canonical order', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return order;
    },
  };
  const app = buildApp({ commerceProvider });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), order);
});

test('GET /v1/orders/:reference returns 404 for an unknown order', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return null;
    },
  };
  const app = buildApp({ commerceProvider });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/MISSING',
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: 'order_not_found',
      message: 'Order was not found',
    },
  });
});

test('GET /v1/orders/:reference hides upstream failures', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      throw new Error('upstream failure details');
    },
  };
  const app = buildApp({ commerceProvider });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: {
      code: 'commerce_provider_unavailable',
      message: 'Commerce provider request failed',
    },
  });
});
