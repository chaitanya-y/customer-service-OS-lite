import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRefundPreview } from '../src/refund-preview.js';

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

const refundContext = {
  observationId: 'refund-context-001',
  observedAt: '2026-08-08T12:00:00.000Z',
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

const decision = {
  schemaVersion: '1' as const,
  decisionId: 'policy-decision-001',
  journeyType: 'REFUND' as const,
  effect: 'ALLOW' as const,
  policyVersion: 'refund-policy-v1',
  inputFactsHash: 'sha256:policy-input',
  factRefs: [],
  reasonCodes: ['WITHIN_AUTOMATIC_REFUND_THRESHOLD'],
  obligations: [],
  missingFacts: [],
  decidedAt: '2026-08-08T12:00:00.000Z',
  validUntil: '2026-08-08T12:15:00.000Z',
};

test('creates an exact confirmation preview from an allowed decision', () => {
  const preview = createRefundPreview({
    proposal,
    refundContext,
    decision,
    previewId: 'preview-001',
    createdAt: '2026-08-08T12:00:00.000Z',
  });

  assert.deepEqual(preview, {
    previewId: 'preview-001',
    createdAt: '2026-08-08T12:00:00.000Z',
    proposalId: 'refund-proposal-001',
    orderId: 'order-001',
    selection: { scope: 'FULL_ORDER', itemIds: [] },
    requestedAmount: { amountMinor: 5_000, currency: 'USD' },
    refundDestination: 'ORIGINAL_PAYMENT_METHOD',
    policyVersion: 'refund-policy-v1',
    decisionId: 'policy-decision-001',
    inputFactsHash: 'sha256:policy-input',
    validUntil: '2026-08-08T12:15:00.000Z',
  });
});

test('does not create a preview for a decision that is not allowed', () => {
  assert.throws(
    () => createRefundPreview({
      proposal,
      refundContext,
      decision: { ...decision, effect: 'DENY' },
      previewId: 'preview-001',
      createdAt: '2026-08-08T12:00:00.000Z',
    }),
    /REFUND_PREVIEW_REQUIRES_ALLOWED_DECISION/,
  );
});

test('requires an explicit supervisor authorization for a takeover preview', () => {
  const takeoverDecision = { ...decision, effect: 'TAKEOVER_REQUIRED' as const };

  assert.throws(
    () => createRefundPreview({
      proposal,
      refundContext,
      decision: takeoverDecision,
      previewId: 'preview-001',
      createdAt: '2026-08-08T12:00:00.000Z',
    }),
    /REFUND_PREVIEW_REQUIRES_ALLOWED_DECISION/,
  );

  const preview = createRefundPreview({
    proposal,
    refundContext,
    decision: takeoverDecision,
    authorization: {
      kind: 'HUMAN_EXCEPTIONAL_APPROVAL',
      caseId: 'case-001',
      decision: 'APPROVE_EXCEPTIONAL_REFUND',
    },
    previewId: 'preview-001',
    createdAt: '2026-08-08T12:00:00.000Z',
  });

  assert.deepEqual(preview.requestedAmount, { amountMinor: 5_000, currency: 'USD' });
});
