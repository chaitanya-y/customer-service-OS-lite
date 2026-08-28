import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import type { CommerceProvider } from '../src/commerce.js';
import { InMemoryRefundExecutionRepository } from '../src/refund-execution-repository.js';
import {
  createHmacProviderRefundEventVerifier,
  createProviderRefundEventSignature,
  PROVIDER_REFUND_EVENT_SIGNATURE_HEADER,
} from '../src/provider-refund-event-routes.js';
import { WORKFLOW_ACCESS_ASSERTION_HEADER } from '../src/workflow-access.js';
import { verifyTestContextAssertion } from './trusted-context-fixture.js';

const provider: CommerceProvider = {
  async getOrderByReference() {
    throw new Error('not used');
  },
  async getOrderById() {
    return {
      source: { provider: 'vendure', orderId: '3' },
      reference: 'ORDER-123',
      status: 'Delivered',
      active: false,
      placedAt: null,
      customer: { id: 'customer-42', name: 'Customer', email: 'customer@example.com' },
      total: { amountMinor: 10_000, currency: 'USD' },
      items: [],
      payments: [{ id: 'payment-1', status: 'Settled', amount: { amountMinor: 10_000, currency: 'USD' }, method: 'card', transactionReference: null, refunds: [] }],
      fulfillments: [],
    };
  },
  async executeRefund() {
    return { status: 'SUBMITTED', providerRefundId: 'provider-refund-001' };
  },
};

test('a signed provider event is replay-safe and becomes a pending Temporal delivery', async (context) => {
  const repository = new InMemoryRefundExecutionRepository();
  const secret = 'local-provider-webhook-secret-with-at-least-32-bytes';
  const app = buildApp({
    commerceProvider: provider,
    refundExecutionRepository: repository,
    verifyContextAssertion: verifyTestContextAssertion,
    verifyProviderRefundEventSignature: createHmacProviderRefundEventVerifier(secret),
    async verifyWorkflowRefundExecutionAssertion() {
      return { contextId: 'workflow-1', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-42', routingEpoch: 1, requestId: 'request-1', traceId: 'trace-1' };
    },
  });
  context.after(() => app.close());

  const execution = await app.inject({
    method: 'POST',
    url: '/internal/v1/refunds',
    headers: { [WORKFLOW_ACCESS_ASSERTION_HEADER]: 'worker-write-assertion' },
    payload: { orderId: '3', reasonCode: 'DAMAGED', amount: { amountMinor: 5_000, currency: 'USD' }, selection: { scope: 'FULL_ORDER', itemIds: [] }, previewId: 'preview-1', idempotencyKey: 'refund:workflow-1:preview-1' },
  });
  assert.deepEqual(execution.json(), { status: 'SUBMITTED', providerRefundId: 'provider-refund-001' });

  const event = {
    eventId: 'provider-event-001',
    providerRefundId: 'provider-refund-001',
    outcome: 'COMPLETED' as const,
    occurredAt: '2026-08-26T12:00:00.000Z',
  };
  const payload = { event_id: event.eventId, provider_refund_id: event.providerRefundId, outcome: event.outcome, occurred_at: event.occurredAt };
  const request = {
    method: 'POST' as const,
    url: '/internal/v1/provider-refund-events',
    headers: { [PROVIDER_REFUND_EVENT_SIGNATURE_HEADER]: createProviderRefundEventSignature(secret, event) },
    payload,
  };
  const first = await app.inject(request);
  const duplicate = await app.inject(request);

  assert.equal(first.statusCode, 202);
  assert.deepEqual(first.json(), { status: 'accepted' });
  assert.deepEqual(duplicate.json(), { status: 'duplicate' });
  assert.deepEqual(await repository.listPendingProviderRefundEvents(10), [{
    ...event,
    workflowId: 'workflow-1',
  }]);
});
