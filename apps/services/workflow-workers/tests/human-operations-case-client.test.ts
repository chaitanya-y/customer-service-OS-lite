import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHumanOperationsCaseClient } from '../src/human-operations-case-client.js';
import type {
  CloseHumanCaseInput,
  OpenHumanCaseInput,
} from '../src/refund-workflow-activities.js';

const openCase: OpenHumanCaseInput = {
  caseId: 'case:refund-001',
  workflowId: 'refund-001',
  idempotencyKey: 'workflow:refund-001:human-case',
  access: {
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-001',
    requestId: 'request-001',
    traceId: 'trace-001',
  },
  caseType: 'REFUND_TAKEOVER',
  allowedActions: ['RESOLVE_TAKEOVER', 'REJECT'],
  reviewPacket: {
    orderReference: 'ORDER-001',
    proposal: {
      proposalId: 'refund-proposal-001',
      orderId: 'order-internal-001',
      reasonCode: 'DAMAGED',
      scope: 'FULL_ORDER',
      itemIds: [],
      requestedAmount: { amountMinor: 50_001, currency: 'USD' },
    },
    policy: {
      decisionId: 'policy-decision-001',
      effect: 'TAKEOVER_REQUIRED',
      policyVersion: 'refund-policy-v1',
      inputFactsHash: 'sha256:policy-input',
      reasonCodes: ['AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'],
      factRefs: [],
    },
  },
};

const closeCase: CloseHumanCaseInput = {
  caseId: openCase.caseId,
  workflowId: openCase.workflowId,
  idempotencyKey: 'workflow:refund-001:human-case:close:RESOLVE_TAKEOVER',
  access: openCase.access,
  outcome: 'TAKEOVER_RESOLVED',
  decision: {
    action: 'RESOLVE_TAKEOVER',
    decidedBy: 'supervisor-001',
    decidedAt: '2026-08-22T12:00:00.000Z',
  },
};

test('opens and closes a human case through the signed, idempotent boundary', async () => {
  const calls: Array<{ url: string; request: RequestInit | undefined }> = [];
  const signedPurposes: string[] = [];
  const client = createHumanOperationsCaseClient({
    baseUrl: 'http://human-operations.local',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    async signWorkflowAccessAssertion(input) {
      signedPurposes.push(input.purpose);
      return 'signed-workflow-assertion';
    },
    async fetchImpl(url, request) {
      calls.push({ url: String(url), request });
      return Response.json({ refund_case: { case_id: 'case:refund-001' } });
    },
  });

  await client.openHumanCase(openCase);
  await client.closeHumanCase(closeCase);

  assert.deepEqual(signedPurposes, ['human_case_open', 'human_case_close']);
  assert.equal(calls[0]?.url, 'http://human-operations.local/internal/v1/refund-cases');
  assert.equal(calls[1]?.url, 'http://human-operations.local/internal/v1/refund-cases/case%3Arefund-001/close');
  assert.equal(new Headers(calls[0]?.request?.headers).get('x-cso-workflow-assertion'), 'signed-workflow-assertion');
  assert.equal(new Headers(calls[0]?.request?.headers).get('idempotency-key'), openCase.idempotencyKey);
  assert.equal(new Headers(calls[1]?.request?.headers).get('idempotency-key'), closeCase.idempotencyKey);
  assert.deepEqual(JSON.parse(String(calls[0]?.request?.body)), {
    workflow_id: openCase.workflowId,
    case_type: openCase.caseType,
    review_packet: {
      order_reference: 'ORDER-001',
      selected_item_ids: [],
      requested_amount: { amount_minor: 50_001, currency: 'USD' },
      refund_reason: 'DAMAGED',
      policy_reason_codes: ['AMOUNT_EXCEEDS_APPROVAL_THRESHOLD'],
      evidence_ids: [],
      policy_version: 'refund-policy-v1',
    },
    policy_version: openCase.reviewPacket.policy.policyVersion,
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.request?.body)), {
    workflow_id: closeCase.workflowId,
  });
});
