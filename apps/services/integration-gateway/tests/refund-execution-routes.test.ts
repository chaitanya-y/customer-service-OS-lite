import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceProvider } from '../src/commerce.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

test('refund execution is Worker-authorized and idempotent', async (context) => {
  let executions = 0;
  const provider: CommerceProvider = {
    async getOrderByReference() {
      return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }], fulfillments: [] };
    },
    async getOrderById(orderId) {
      assert.equal(orderId, '3');
      return { source: { provider: 'vendure', orderId: '3' }, reference: 'ORDER-123', status: 'Delivered', active: false, placedAt: null, customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' }, total: { amountMinor: 10_000, currency: 'USD' }, items: [], payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }], fulfillments: [] };
    },
    async executeRefund() { executions += 1; return { status: 'SUCCEEDED', providerRefundId: 'refund-1' }; },
  };
  const app = buildApp({ commerceProvider: provider, verifyContextAssertion: verifyTestContextAssertion, async verifyWorkflowRefundExecutionAssertion(value) { assert.equal(value, 'worker-write-assertion'); return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1' }; } });
  context.after(() => app.close());
  const request = { method: 'POST' as const, url: '/internal/v1/refunds', headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'worker-write-assertion' }, payload: { orderId: '3', reasonCode: 'DAMAGED', amount: { amountMinor: 5_000, currency: 'USD' }, selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' } };
  const first = await app.inject(request);
  const second = await app.inject(request);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { status: 'SUCCEEDED', providerRefundId: 'refund-1' });
  assert.deepEqual(second.json(), first.json());
  assert.equal(executions, 1);
});
