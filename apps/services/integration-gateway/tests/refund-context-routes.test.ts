import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceOrder, CommerceProvider } from '../src/commerce.js';
import { CONTEXT_ASSERTION_HEADER } from '../src/trusted-context.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';
import {
  TEST_CONTEXT_ASSERTION,
  verifyTestContextAssertion,
} from './trusted-context-fixture.js';

const order: CommerceOrder = {
  source: { provider: 'vendure', orderId: '3' },
  reference: 'ORDER-123',
  status: 'Delivered',
  active: false,
  placedAt: '2026-07-25T23:59:40.265Z',
  customer: {
    id: 'customer-42',
    name: 'Private Customer',
    email: 'private@example.com',
  },
  total: { amountMinor: 10_000, currency: 'USD' },
  items: [],
  payments: [
    {
      id: 'payment-1',
      status: 'Settled',
      amount: { amountMinor: 10_000, currency: 'USD' },
      method: 'standard-payment',
      transactionReference: 'secret-transaction-reference',
      refunds: [],
    },
  ],
  fulfillments: [],
};

test('POST /internal/v1/refund-contexts returns trusted refund facts', async (context) => {
  let receivedOrderId: string | undefined;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return order;
    },
    async getOrderById(orderId) {
      receivedOrderId = orderId;
      return order;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-contexts',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
    },
    payload: {
      orderId: '3',
      selection: { scope: 'FULL_ORDER', itemIds: [] },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(receivedOrderId, '3');
  assert.deepEqual(response.json().facts, {
    customerVerified: true,
    transactionRefundable: true,
    itemSelectionValid: true,
    priorRefundCount: 0,
    refundableAmount: { amountMinor: 10_000, currency: 'USD' },
    refundDestination: 'ORIGINAL_PAYMENT_METHOD',
  });
  assert.doesNotMatch(response.body, /secret-transaction-reference/);
});

test('POST /internal/v1/refund-contexts requires trusted context', async (context) => {
  let providerCalled = false;
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      providerCalled = true;
      return order;
    },
    async getOrderById() {
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
    method: 'POST',
    url: '/internal/v1/refund-contexts',
    payload: {
      orderId: '3',
      selection: { scope: 'FULL_ORDER', itemIds: [] },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(providerCalled, false);
});

test('POST /internal/v1/refund-contexts accepts a Workflow Worker assertion', async (context) => {
  const commerceProvider: CommerceProvider = {
    async getOrderByReference() {
      return order;
    },
    async getOrderById(orderId) {
      assert.equal(orderId, '3');
      return order;
    },
  };
  const app = buildApp({
    commerceProvider,
    verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowAccessAssertion(assertion) {
      assert.equal(assertion, 'workflow-assertion');
      return {
        contextId: 'refund-workflow-001',
        tenantId: 'tenant-local',
        environmentId: 'local',
        subjectCustomerId: 'customer-42',
        routingEpoch: 1,
        requestId: 'request-001',
        traceId: 'trace-001',
      };
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-contexts',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'workflow-assertion' },
    payload: {
      orderId: '3',
      selection: { scope: 'FULL_ORDER', itemIds: [] },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().source.orderId, '3');
});

test('POST /internal/v1/refund-contexts rejects ambiguous customer and worker access', async (context) => {
  let providerCalled = false;
  const app = buildApp({
    commerceProvider: {
      async getOrderByReference() {
        providerCalled = true;
        return order;
      },
      async getOrderById() {
        providerCalled = true;
        return order;
      },
    },
    verifyContextAssertion: verifyTestContextAssertion,
    async verifyWorkflowAccessAssertion() {
      throw new Error('must not verify ambiguous access');
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-contexts',
    headers: {
      [CONTEXT_ASSERTION_HEADER]: TEST_CONTEXT_ASSERTION,
      [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'workflow-assertion',
    },
    payload: {
      orderId: '3',
      selection: { scope: 'FULL_ORDER', itemIds: [] },
    },
  });

  assert.equal(response.statusCode, 401);
  assert.equal(providerCalled, false);
});
