import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIntegrationGatewayRefundContextClient } from '../src/integration-gateway-client.js';
import type { RefreshRefundContextInput } from '../src/refund-workflow-activities.js';

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
    orderReference: 'ORDER-123',
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
