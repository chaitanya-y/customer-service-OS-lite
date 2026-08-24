import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommerceOrder } from '../src/commerce.js';
import { toOrderContext } from '../src/order-context.js';

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
  items: [
    {
      id: 'line-1',
      sku: 'SKU-1',
      name: 'Test product',
      quantity: 2,
      unitPrice: {
        amountMinor: 5_000,
        currency: 'USD',
      },
      lineTotal: {
        amountMinor: 10_000,
        currency: 'USD',
      },
    },
  ],
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
      refunds: [],
    },
  ],
  fulfillments: [
    {
      id: 'fulfillment-1',
      status: 'Delivered',
      method: 'manual-fulfillment',
      trackingCode: 'TRACK-123',
    },
  ],
};

test('toOrderContext creates a safe, versioned order observation', () => {
  const orderContext = toOrderContext(commerceOrder, {
    observationId: 'observation-1',
    observedAt: '2026-07-26T12:00:00.000Z',
  });

  assert.deepEqual(orderContext, {
    schemaVersion: '1',
    observationId: 'observation-1',
    observedAt: '2026-07-26T12:00:00.000Z',
    source: {
      provider: 'vendure',
      orderId: '3',
      factsVersion: orderContext.source.factsVersion,
    },
    reference: 'ORDER-123',
    status: 'Delivered',
    active: false,
    placedAt: '2026-07-25T23:59:40.265Z',
    customerRef: {
      customerId: 'customer-42',
    },
    total: {
      amountMinor: 10_000,
      currency: 'USD',
    },
    items: [
      {
        itemId: 'line-1',
        sku: 'SKU-1',
        name: 'Test product',
        quantity: 2,
        unitPrice: {
          amountMinor: 5_000,
          currency: 'USD',
        },
        lineTotal: {
          amountMinor: 10_000,
          currency: 'USD',
        },
      },
    ],
    payments: [
      {
        paymentId: 'payment-1',
        status: 'Settled',
        amount: {
          amountMinor: 10_000,
          currency: 'USD',
        },
        method: 'standard-payment',
      },
    ],
    fulfillments: [
      {
        fulfillmentId: 'fulfillment-1',
        status: 'Delivered',
        method: 'manual-fulfillment',
        trackingCode: 'TRACK-123',
      },
    ],
  });

  assert.match(orderContext.source.factsVersion, /^sha256:[a-f0-9]{64}$/);

  const serializedContext = JSON.stringify(orderContext);
  assert.doesNotMatch(serializedContext, /Private Customer/);
  assert.doesNotMatch(serializedContext, /private@example\.com/);
  assert.doesNotMatch(serializedContext, /secret-transaction-reference/);
});
