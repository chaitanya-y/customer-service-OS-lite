import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateRefundPolicy, type RefundPolicyInput } from '../src/refund-policy.js';
import { createRefundPolicyInput, type RefundContext, type RefundProposal } from '../src/refund-policy-input.js';
import { getRefundPolicyRelease, REFUND_POLICY_V1, REFUND_POLICY_V2 } from '../src/refund-policy-release.js';
import type { AcceptedDamageEvidence } from '../src/refund-evidence-client.js';

const now = '2026-09-05T12:00:00Z';
const accepted: AcceptedDamageEvidence = { evidenceVersion: 2, assessmentId: '00000000-0000-4000-8000-000000000001', manifestHash: `sha256:${'a'.repeat(64)}`, observedAt: now };
const proposal: RefundProposal = { proposalId: 'proposal-1', journeyType: 'REFUND', intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'FULL_ORDER', itemIds: [], requestedAmount: { amountMinor: 5000, currency: 'USD' } } };
const refundContext: RefundContext = {
  observationId: 'observation-1', observedAt: now, source: { provider: 'vendure', orderId: 'order-1', factsVersion: 'facts-1' }, selection: { scope: 'FULL_ORDER', itemIds: [] },
  facts: { customerVerified: true, transactionRefundable: true, itemSelectionValid: true, priorRefundCount: 0, refundableAmount: { amountMinor: 60_000, currency: 'USD' }, refundDestination: 'ORIGINAL_PAYMENT_METHOD' },
};
function policyInput(version = 'refund-policy-v2', evidence?: AcceptedDamageEvidence): RefundPolicyInput {
  return createRefundPolicyInput({ proposal, refundContext, policyVersion: version, ...(evidence ? { damageEvidence: evidence } : {}) });
}
function evaluate(input: RefundPolicyInput) {
  return evaluateRefundPolicy(input, getRefundPolicyRelease(input.policyVersion), { decisionId: 'decision-1', decidedAt: now });
}

test('v1 remains immutable and unaffected; only pinned v2 damaged requests require accepted photo evidence', () => {
  assert.equal(Object.isFrozen(REFUND_POLICY_V1), true); assert.equal(REFUND_POLICY_V1.requireDamagePhoto, undefined);
  assert.equal(REFUND_POLICY_V2.requireDamagePhoto, true);
  assert.equal(evaluate(policyInput('refund-policy-v1')).effect, 'ALLOW');
  const decision = evaluate(policyInput());
  assert.equal(decision.effect, 'NEEDS_FACTS'); assert.deepEqual(decision.missingFacts, ['DAMAGE_PHOTO']);
  const otherReason = policyInput();
  assert.equal(evaluate({ ...otherReason, request: { ...otherReason.request, reasonCode: 'DEFECTIVE' } }).effect, 'ALLOW');
  assert.throws(() => getRefundPolicyRelease('refund-policy-unknown'), /UNKNOWN_REFUND_POLICY_VERSION/);
});

test('only separately supplied trusted assessment evidence enters policy fact refs', () => {
  const built = policyInput('refund-policy-v2', accepted);
  assert.deepEqual(built.factRefs.find(ref => ref.factType === 'ACCEPTED_DAMAGE_EVIDENCE'), {
    factId: accepted.assessmentId, factType: 'ACCEPTED_DAMAGE_EVIDENCE', sourceVersion: accepted.manifestHash, observedAt: now,
  });
  const injected = createRefundPolicyInput({ policyVersion: 'refund-policy-v2', refundContext, proposal: { ...proposal, damageEvidence: accepted } as RefundProposal });
  assert.equal(injected.factRefs.some(ref => ref.factType === 'ACCEPTED_DAMAGE_EVIDENCE'), false);
  assert.equal(evaluate(injected).effect, 'NEEDS_FACTS');
  const technicallyReady = { ...policyInput(), factRefs: [{ factId: accepted.assessmentId, factType: 'READY_DAMAGE_PHOTO', sourceVersion: accepted.manifestHash, observedAt: now }] };
  assert.equal(evaluate(technicallyReady).effect, 'NEEDS_FACTS');
  assert.equal(evaluate(policyInput('refund-policy-v2', { ...accepted, manifestHash: 'unverified' })).effect, 'NEEDS_FACTS');
});

test('accepted photos preserve automatic/approval/takeover monetary boundaries exactly', () => {
  for (const [amountMinor, effect] of [[10_000, 'ALLOW'], [10_001, 'APPROVAL_REQUIRED'], [50_000, 'APPROVAL_REQUIRED'], [50_001, 'TAKEOVER_REQUIRED']] as const) {
    const input = policyInput('refund-policy-v2', accepted);
    assert.equal(evaluate({ ...input, request: { ...input.request, requestedAmount: { amountMinor, currency: 'USD' } } }).effect, effect);
  }
});

test('accepted photos do not override trusted refundability, currency, balance or risk protections', () => {
  const input = policyInput('refund-policy-v2', accepted);
  for (const facts of [
    { ...input.facts, transactionRefundable: false },
    { ...input.facts, customerVerified: false },
    { ...input.facts, refundableAmount: { amountMinor: 1, currency: 'USD' } },
    { ...input.facts, refundableAmount: { amountMinor: 60_000, currency: 'EUR' } },
  ]) assert.equal(evaluate({ ...input, facts }).effect, 'DENY');
  assert.equal(evaluate({ ...input, facts: { ...input.facts, priorRefundCount: 1 } }).effect, 'APPROVAL_REQUIRED');
  assert.equal(evaluate({ ...input, facts: { ...input.facts, priorRefundCount: 2 } }).effect, 'TAKEOVER_REQUIRED');
  assert.equal(evaluate({ ...input, facts: { ...input.facts, refundDestination: 'STORE_CREDIT' } }).effect, 'TAKEOVER_REQUIRED');
});
