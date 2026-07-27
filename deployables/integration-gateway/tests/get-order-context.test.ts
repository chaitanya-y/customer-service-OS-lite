import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CommerceOrder,
  CommerceProvider,
} from '../src/commerce.js';
import { createGetOrderContext } from '../src/get-order-context.js';

const commerceOrder: CommerceOrder = {
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
  payments: [],
  fulfillments: [],
};

test('getOrderContext reads an order and returns a safe observation', async () => {
  let receivedReference: string | undefined;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference(reference) {
      receivedReference = reference;
      return commerceOrder;
    },
  };
  const getOrderContext = createGetOrderContext({
    commerceProvider,
    createObservationId: () => 'observation-1',
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });

  const orderContext = await getOrderContext('ORDER-123');

  assert.equal(receivedReference, 'ORDER-123');
  assert.equal(orderContext?.observationId, 'observation-1');
  assert.equal(orderContext?.observedAt, '2026-07-26T12:00:00.000Z');
  assert.deepEqual(orderContext?.customerRef, {
    customerId: 'customer-42',
  });

  const serializedContext = JSON.stringify(orderContext);
  assert.doesNotMatch(serializedContext, /Private Customer/);
  assert.doesNotMatch(serializedContext, /private@example\.com/);
});

test('getOrderContext returns null when the order does not exist', async () => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return null;
    },
  };
  const getOrderContext = createGetOrderContext({
    commerceProvider,
    createObservationId: () => 'unused-observation-id',
    now: () => new Date('2026-07-26T12:00:00.000Z'),
  });

  const orderContext = await getOrderContext('MISSING');

  assert.equal(orderContext, null);
});
