import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIntegrationGatewayRefundContextClient } from '../src/integration-gateway-client.js';
import type { RefreshRefundContextInput } from '../src/refund-workflow-activities.js';
import type { RefundPreview } from '../src/refund-preview.js';

const input: RefreshRefundContextInput = {
  workflowId: 'refund-workflow-001',
  access: {
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    requestId: 'request-001',
    traceId: 'trace-001',
  },
  proposal: {
    proposalId: 'refund-proposal-001',
    journeyType: 'REFUND',
    intent: {
      orderId: 'ORDER-123',
      reasonCode: 'DAMAGED',
      scope: 'FULL_ORDER',
      itemIds: [],
      requestedAmount: { amountMinor: 5_000, currency: 'USD' },
    },
  },
};

const preview: RefundPreview = {
  previewId: 'preview-001',
  createdAt: '2026-08-08T12:00:00.000Z',
  proposalId: 'refund-proposal-001',
  orderId: 'ORDER-123',
  selection: { scope: 'FULL_ORDER', itemIds: [] },
  requestedAmount: { amountMinor: 5_000, currency: 'USD' },
  refundDestination: 'ORIGINAL_PAYMENT_METHOD',
  policyVersion: 'refund-policy-001',
  decisionId: 'decision-001',
  inputFactsHash: 'sha256:facts',
  validUntil: '2026-08-08T12:05:00.000Z',
};

test('refreshes trusted refund facts with a Worker assertion', async () => {
  let capturedRequest: RequestInit | undefined;
  const client = createIntegrationGatewayRefundContextClient({
    baseUrl: 'http://gateway.local',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion(assertionInput) {
      assert.equal(assertionInput.workflowId, 'refund-workflow-001');
      assert.equal(assertionInput.access.subjectCustomerId, 'customer-42');
      return 'signed-worker-assertion';
    },
    async fetchImpl(_url, request) {
      capturedRequest = request;
      return new Response(JSON.stringify({
        schemaVersion: '1',
        observationId: 'refund-context-001',
        observedAt: '2026-08-08T12:00:00.000Z',
        source: { provider: 'vendure', orderId: 'ORDER-123', factsVersion: 'sha256:facts' },
        selection: { scope: 'FULL_ORDER', itemIds: [] },
        facts: {
          customerVerified: true,
          transactionRefundable: true,
          itemSelectionValid: true,
          priorRefundCount: 0,
          refundableAmount: { amountMinor: 5_000, currency: 'USD' },
          refundDestination: 'ORIGINAL_PAYMENT_METHOD',
        },
      }), { status: 200 });
    },
  });

  const context = await client.fetchRefundContext(input);

  assert.equal(new Headers(capturedRequest?.headers).get('x-cso-workflow-assertion'), 'signed-worker-assertion');
  assert.deepEqual(JSON.parse(String(capturedRequest?.body)), {
    orderId: 'ORDER-123',
    selection: { scope: 'FULL_ORDER', itemIds: [] },
  });
  assert.equal(context.facts.refundableAmount.amountMinor, 5_000);
});

test('refuses to guess an unspecified refund selection', async () => {
  const client = createIntegrationGatewayRefundContextClient({
    baseUrl: 'http://gateway.local',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion() {
      return 'not-used';
    },
  });

  await assert.rejects(
    client.fetchRefundContext({
      ...input,
      proposal: {
        ...input.proposal,
        intent: { ...input.proposal.intent, scope: 'UNSPECIFIED' },
      },
    }),
    /REFUND_SELECTION_REQUIRED/,
  );
});

test('uses the internal order ID for refund execution and reconciliation', async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const client = createIntegrationGatewayRefundContextClient({
    baseUrl: 'http://gateway.local',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion() {
      return 'signed-worker-assertion';
    },
    async fetchImpl(url, request) {
      requests.push({ url: String(url), body: JSON.parse(String(request?.body)) });
      return Response.json({ status: 'SUCCEEDED', providerRefundId: 'refund-001' });
    },
  });

  await client.executeRefund({ ...input, preview });
  await client.reconcileRefund({ ...input, preview });

  assert.deepEqual(requests, [
    {
      url: 'http://gateway.local/internal/v1/refunds',
      body: {
        orderId: 'ORDER-123',
        reasonCode: 'DAMAGED',
        amount: { amountMinor: 5_000, currency: 'USD' },
        selection: { scope: 'FULL_ORDER', itemIds: [] },
        previewId: 'preview-001',
        idempotencyKey: 'refund:refund-workflow-001:preview-001',
      },
    },
    {
      url: 'http://gateway.local/internal/v1/refund-reconciliations',
      body: {
        orderId: 'ORDER-123',
        previewId: 'preview-001',
        amount: { amountMinor: 5_000, currency: 'USD' },
      },
    },
  ]);
});
