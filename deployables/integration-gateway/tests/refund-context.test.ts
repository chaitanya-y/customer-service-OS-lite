import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CommerceOrder } from '../src/commerce.js';
import { toRefundContext } from '../src/refund-context.js';

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
    amountMinor: 15_000,
    currency: 'USD',
  },
  items: [
    {
      id: 'line-1',
      sku: 'SKU-1',
      name: 'First item',
      quantity: 1,
      unitPrice: { amountMinor: 10_000, currency: 'USD' },
      lineTotal: { amountMinor: 10_000, currency: 'USD' },
    },
    {
      id: 'line-2',
      sku: 'SKU-2',
      name: 'Second item',
      quantity: 1,
      unitPrice: { amountMinor: 5_000, currency: 'USD' },
      lineTotal: { amountMinor: 5_000, currency: 'USD' },
    },
  ],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: { amountMinor: 15_000, currency: 'USD' },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
      refunds: [
        {
          id: 'refund-1',
          status: 'Settled',
          amount: { amountMinor: 5_000, currency: 'USD' },
          lineIds: ['line-2'],
        },
      ],
    },
  ],
  fulfillments: [],
};

const observation = {
  observationId: 'observation-1',
  observedAt: '2026-07-26T12:00:00.000Z',
};

test('refund context uses remaining settled-payment balance for a full order', () => {
  const refundContext = toRefundContext(
    order,
    { scope: 'FULL_ORDER', itemIds: [] },
    observation,
  );

  assert.equal(refundContext.facts.transactionRefundable, true);
  assert.equal(refundContext.facts.itemSelectionValid, true);
  assert.equal(refundContext.facts.priorRefundCount, 1);
  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 10_000,
    currency: 'USD',
  });
  assert.equal(refundContext.facts.refundDestination, 'ORIGINAL_PAYMENT_METHOD');
  assert.match(refundContext.source.factsVersion, /^sha256:[a-f0-9]{64}$/);

  const serializedContext = JSON.stringify(refundContext);
  assert.doesNotMatch(serializedContext, /secret-transaction-reference/);
  assert.doesNotMatch(serializedContext, /Private Customer/);
});

test('refund context fails closed for a selected item already in a refund', () => {
  const refundContext = toRefundContext(
    order,
    { scope: 'SELECTED_ITEMS', itemIds: ['line-2'] },
    observation,
  );

  assert.equal(refundContext.facts.itemSelectionValid, false);
  assert.equal(refundContext.facts.priorRefundCount, 1);
  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 0,
    currency: 'USD',
  });
});

test('a failed refund does not consume the refundable balance', () => {
  const failedRefundOrder: CommerceOrder = {
    ...order,
    payments: [
      {
        ...order.payments[0],
        refunds: [
          {
            id: 'refund-failed',
            status: 'Failed',
            amount: { amountMinor: 5_000, currency: 'USD' },
            lineIds: ['line-2'],
          },
        ],
      },
    ],
  };
  const refundContext = toRefundContext(
    failedRefundOrder,
    { scope: 'FULL_ORDER', itemIds: [] },
    observation,
  );

  assert.deepEqual(refundContext.facts.refundableAmount, {
    amountMinor: 15_000,
    currency: 'USD',
  });
  assert.equal(refundContext.facts.priorRefundCount, 0);
});
