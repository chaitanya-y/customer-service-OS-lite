import assert from 'node:assert/strict';
import { test } from 'node:test';

import { REFUND_POLICY_V1 } from '../src/refund-policy-release.js';
import { createRefundWorkflowActivities } from '../src/refund-workflow-activities.js';

const proposal = {
  proposalId: 'refund-proposal-001',
  journeyType: 'REFUND' as const,
  intent: {
    orderId: 'order-001',
    reasonCode: 'DAMAGED',
    scope: 'FULL_ORDER' as const,
    itemIds: [],
    requestedAmount: { amountMinor: 5_000, currency: 'USD' },
  },
};

const access = {
  tenantId: 'tenant-local',
  environmentId: 'local',
  subjectCustomerId: 'customer-001',
  requestId: 'request-001',
  traceId: 'trace-001',
};

const refundContext = {
  observationId: 'refund-context-001',
  observedAt: '2026-09-17T12:00:00.000Z',
  source: { provider: 'vendure', orderId: 'order-001', factsVersion: 'sha256:facts' },
  selection: { scope: 'FULL_ORDER' as const, itemIds: [] },
  facts: {
    customerVerified: true as const,
    transactionRefundable: true,
    itemSelectionValid: true,
    priorRefundCount: 0,
    refundableAmount: { amountMinor: 5_000, currency: 'USD' },
    refundDestination: 'ORIGINAL_PAYMENT_METHOD' as const,
  },
};

test('activity adapters expose fixed, input-free refund boundaries to telemetry', async () => {
  const observations: Array<{ operation: string; dependency?: string; outcome?: string }> = [];
  const telemetry = {
    async withActivity<T>(input: {
      operation: string;
      dependency?: string;
      outcome?: (value: T) => string | undefined;
    }, activity: () => Promise<T>): Promise<T> {
      const value = await activity();
      observations.push({
        operation: input.operation,
        ...(input.dependency === undefined ? {} : { dependency: input.dependency }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome(value) }),
      });
      return value;
    },
  };
  const activities = createRefundWorkflowActivities({
    fetchRefundContext: async () => refundContext,
    executeRefund: async () => ({ status: 'SUBMITTED' as const }),
    reconcileRefund: async () => ({ status: 'PROCESSING' as const }),
    openHumanCase: async (input) => ({ caseId: input.caseId }),
    closeHumanCase: async () => {},
    refundPolicyRelease: REFUND_POLICY_V1,
    createDecisionContext: () => ({ decisionId: 'decision-001', decidedAt: '2026-09-17T12:00:00.000Z' }),
    createPreviewContext: () => ({ previewId: 'preview-001', createdAt: '2026-09-17T12:00:00.000Z' }),
    telemetry,
  });

  const refreshInput = { proposal, workflowId: 'workflow-001', access };
  const context = await activities.refreshRefundContext(refreshInput);
  const decision = await activities.evaluateRefundPolicy({ proposal, refundContext: context, policyVersion: 'refund-policy-v1' });
  const preview = await activities.createRefundPreview({ proposal, refundContext: context, decision });
  const humanCase = {
    caseId: 'case-001', workflowId: 'workflow-001', idempotencyKey: 'human-case-001', access,
    caseType: 'REFUND_APPROVAL' as const, allowedActions: ['APPROVE' as const],
    reviewPacket: {
      proposal: { proposalId: proposal.proposalId, orderId: proposal.intent.orderId, reasonCode: proposal.intent.reasonCode, scope: proposal.intent.scope, itemIds: [] },
      policy: { decisionId: decision.decisionId, effect: decision.effect, policyVersion: decision.policyVersion, inputFactsHash: decision.inputFactsHash, reasonCodes: [], factRefs: [] },
    },
  };
  await activities.openHumanCase(humanCase);
  await activities.closeHumanCase({
    caseId: humanCase.caseId, workflowId: humanCase.workflowId, idempotencyKey: 'human-case-close-001', access,
    outcome: 'APPROVED', decision: { action: 'APPROVE', decidedBy: 'staff-001', decidedAt: '2026-09-17T12:00:00.000Z' },
  });
  await activities.recordRefundConfirmation();
  await activities.executeRefund({ proposal, preview, workflowId: 'workflow-001', access });
  await activities.reconcileRefund({ proposal, preview, workflowId: 'workflow-001', access });

  assert.deepEqual(observations, [
    { operation: 'temporal.activity.refund_context_refresh', dependency: 'integration_gateway' },
    { operation: 'temporal.activity.refund_policy_evaluation' },
    { operation: 'temporal.activity.refund_preview_create' },
    { operation: 'temporal.activity.human_case_open', dependency: 'human_operations' },
    { operation: 'temporal.activity.human_case_close', dependency: 'human_operations' },
    { operation: 'temporal.activity.refund_confirmation_handle' },
    { operation: 'temporal.activity.refund_submission', dependency: 'integration_gateway', outcome: 'submitted' },
    { operation: 'temporal.activity.refund_reconciliation', dependency: 'integration_gateway', outcome: 'processing' },
  ]);
  assert.equal(JSON.stringify(observations).includes('customer-001'), false);
  assert.equal(JSON.stringify(observations).includes('order-001'), false);
  assert.equal(JSON.stringify(observations).includes('tenant-local'), false);
});

test('evidence activities use Human Operations boundaries without exposing evidence input', async () => {
  const observations: Array<{ operation: string; dependency?: string }> = [];
  const telemetry = {
    async withActivity<T>(input: { operation: string; dependency?: string }, activity: () => Promise<T>): Promise<T> {
      const value = await activity();
      observations.push({ operation: input.operation, ...(input.dependency === undefined ? {} : { dependency: input.dependency }) });
      return value;
    },
  };
  const snapshot = { caseId: 'case-001', assessment: 'UNREVIEWED' as const, evidenceVersion: 0, readyCount: 0, processingCount: 0 };
  const activities = createRefundWorkflowActivities({
    fetchRefundContext: async () => refundContext,
    executeRefund: async () => ({ status: 'SUCCEEDED' as const }),
    reconcileRefund: async () => ({ status: 'SUCCEEDED' as const }),
    openHumanCase: async (input) => ({ caseId: input.caseId }),
    closeHumanCase: async () => {},
    refundPolicyRelease: REFUND_POLICY_V1,
    createDecisionContext: () => ({ decisionId: 'decision-001', decidedAt: '2026-09-17T12:00:00.000Z' }),
    createPreviewContext: () => ({ previewId: 'preview-001', createdAt: '2026-09-17T12:00:00.000Z' }),
    evidence: {
      async openRefundEvidence() { return snapshot; },
      async readRefundEvidence() { return snapshot; },
      async transitionRefundEvidence() { return { caseId: snapshot.caseId }; },
      async closeRefundEvidence() {},
    },
    telemetry,
  });
  const humanCase = {
    caseId: snapshot.caseId, workflowId: 'workflow-001', idempotencyKey: 'evidence-open-001', access,
    caseType: 'REFUND_EVIDENCE_REVIEW' as const, allowedActions: [],
    reviewPacket: {
      proposal: { proposalId: proposal.proposalId, orderId: proposal.intent.orderId, reasonCode: proposal.intent.reasonCode, scope: proposal.intent.scope, itemIds: [] },
      policy: { decisionId: 'decision-001', effect: 'NEEDS_FACTS' as const, policyVersion: 'refund-policy-v2', inputFactsHash: 'sha256:facts', reasonCodes: [], factRefs: [] },
    },
  };
  const evidenceAccess = { proposal, workflowId: 'workflow-001', access, policyVersion: 'refund-policy-v2' };

  await activities.openRefundEvidence!(humanCase);
  await activities.readRefundEvidence!(evidenceAccess);
  await activities.transitionRefundEvidence!({ ...humanCase, evidenceVersion: 0 });
  await activities.closeRefundEvidence!({ ...evidenceAccess, caseId: snapshot.caseId, outcome: 'EVIDENCE_REVIEW_COMPLETED' });

  assert.deepEqual(observations, [
    { operation: 'temporal.activity.refund_evidence_open', dependency: 'human_operations' },
    { operation: 'temporal.activity.refund_evidence_read', dependency: 'human_operations' },
    { operation: 'temporal.activity.refund_evidence_transition', dependency: 'human_operations' },
    { operation: 'temporal.activity.refund_evidence_close', dependency: 'human_operations' },
  ]);
  assert.equal(JSON.stringify(observations).includes('case-001'), false);
});
