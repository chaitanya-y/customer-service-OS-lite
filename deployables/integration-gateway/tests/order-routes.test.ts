import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type {
  CommerceOrder,
  CommerceProvider,
} from '../src/commerce.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import {
  createTestContextAssertion,
  TEST_CONTEXT_ASSERTION,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

const order: CommerceOrder = {
  source: {
    provider: 'vendure',
    orderId: '3',
  },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: {
    amountMinor: 10_000,
    currency: 'USD',
  },
  items: [],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: {
        amountMinor: 10_000,
        currency: 'USD',
      },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
    },
  ],
  fulfillments: [],
};

test('GET /v1/orders/:reference returns a safe order context', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return order;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.schemaVersion, '1');
  assert.equal(typeof body.observationId, 'string');
  assert.equal(typeof body.observedAt, 'string');
  assert.deepEqual(body.customerRef, {
    customerId: 'customer-42',
  });
  assert.match(body.source.factsVersion, /^sha256:[a-f0-9]{64}$/);

  const serializedBody = JSON.stringify(body);
  assert.doesNotMatch(serializedBody, /Private Customer/);
  assert.doesNotMatch(serializedBody, /private@example\.com/);
  assert.doesNotMatch(serializedBody, /secret-transaction-reference/);
});

test('GET /v1/orders/:reference returns 404 for an unknown order', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return null;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/MISSING',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
    },
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
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: {
      code: 'commerce_provider_unavailable',
      message: 'Commerce provider request failed',
    },
  });
});

test('GET /v1/orders/:reference rejects a missing context assertion', async (
  context,
) => {
  let providerCalled = false;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      providerCalled = true;
      return order;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
  });

  assert.equal(response.statusCode, 401);
  assert.equal(providerCalled, false);
  assert.deepEqual(response.json(), {
    error: {
      code: 'context_unauthorized',
      message: 'Trusted context is required',
    },
  });
});

test('GET /v1/orders/:reference hides another customer order', async (
  context,
) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return order;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'GET',
    url: '/v1/orders/ORDER-123',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: createTestContextAssertion({
        customerId: 'customer-other',
      }),
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: {
      code: 'order_not_found',
      message: 'Order was not found',
    },
  });
});
