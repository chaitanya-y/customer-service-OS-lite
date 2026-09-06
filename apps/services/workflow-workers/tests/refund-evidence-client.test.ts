import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRefundEvidenceClient, parseEvidenceSnapshot, type EvidenceAccess } from '../src/refund-evidence-client.js';
import type { OpenHumanCaseInput } from '../src/refund-workflow-activities.js';

const access = { tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-1', requestId: 'request-1', traceId: 'trace-1' };
const input: EvidenceAccess = {
  workflowId: 'refund-photo-1', access, policyVersion: 'refund-policy-v2',
  proposal: { proposalId: 'proposal-1', journeyType: 'REFUND', intent: { orderId: 'order-1', reasonCode: 'DAMAGED', scope: 'SELECTED_ITEMS', itemIds: ['item-1', 'item-2'], requestedAmount: { amountMinor: 5000, currency: 'USD' } } },
};
const fileId = '00000000-0000-4000-8000-000000000001';
const assessmentId = '00000000-0000-4000-8000-000000000002';
const hash = `sha256:${'a'.repeat(64)}`;
const now = new Date('2026-09-05T12:00:00Z');
function snapshot() {
  return {
    case_id: 'case-1', case_status: 'CLAIMED',
    evidence: { version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: 2, assessment: 'ACCEPTED', can_upload: false,
      attachments: [{ evidence_id: fileId, technical_status: 'READY', display_label: 'Photo 1', content_type: 'image/png', byte_size: 80, width: 1, height: 1, uploaded_at: now.toISOString() }] },
    binding: { order_id: 'order-1', proposal_id: 'proposal-1', selected_item_ids: ['item-2', 'item-1'], policy_version: 'refund-policy-v2' },
    accepted_manifest_hash: hash, assessment_id: assessmentId,
  };
}

test('accepted evidence is bound to order, proposal, selected items and pinned policy, independently of selection order', () => {
  const parsed = parseEvidenceSnapshot(snapshot(), input, now);
  assert.deepEqual(parsed.accepted, { evidenceVersion: 2, assessmentId, manifestHash: hash, observedAt: now.toISOString() });
  assert.equal(parsed.readyCount, 1); assert.equal(parsed.processingCount, 0);
  for (const binding of [
    { order_id: 'other-order' }, { proposal_id: 'other-proposal' },
    { selected_item_ids: ['item-1'] }, { selected_item_ids: ['item-1', 'item-1'] }, { policy_version: 'refund-policy-v1' },
  ]) {
    const value = snapshot();
    assert.throws(() => parseEvidenceSnapshot({ ...value, binding: { ...value.binding, ...binding } }, input), /REFUND_EVIDENCE_BINDING_MISMATCH/);
  }
});

test('malformed accepted evidence, duplicate files and oversized sets fail closed', () => {
  const value = snapshot();
  for (const evidence of [
    { ...value.evidence, evidence_version: 0 }, { ...value.evidence, can_upload: true },
    { ...value.evidence, attachments: [] },
    { ...value.evidence, attachments: [{ ...value.evidence.attachments[0], technical_status: 'PROCESSING' }] },
    { ...value.evidence, attachments: [{ ...value.evidence.attachments[0], technical_status: 'REJECTED' }] },
    { ...value.evidence, attachments: [value.evidence.attachments[0], value.evidence.attachments[0]] },
    { ...value.evidence, attachments: Array.from({ length: 6 }, () => value.evidence.attachments[0]) },
  ]) assert.throws(() => parseEvidenceSnapshot({ ...value, evidence }, input));
  for (const key of ['assessment_id', 'accepted_manifest_hash'] as const) {
    const incomplete: Record<string, unknown> = snapshot(); delete incomplete[key];
    assert.throws(() => parseEvidenceSnapshot(incomplete, input));
  }
  assert.throws(() => parseEvidenceSnapshot({ ...value, accepted_manifest_hash: 'not-a-manifest' }, input));
});

test('unreviewed READY uploads and MORE_REQUIRED never become accepted evidence facts', () => {
  const value = snapshot();
  for (const assessment of ['UNREVIEWED', 'MORE_REQUIRED']) {
    const parsed = parseEvidenceSnapshot({ ...value, evidence: { ...value.evidence, assessment, can_upload: true } }, input, now);
    assert.equal(parsed.readyCount, 1); assert.equal(parsed.accepted, undefined);
  }
});

const openInput: OpenHumanCaseInput = {
  workflowId: input.workflowId, access, caseId: 'case-1', idempotencyKey: 'case-open-1', caseType: 'REFUND_EVIDENCE_REVIEW', allowedActions: [],
  reviewPacket: {
    orderReference: 'ORDER-1',
    proposal: { proposalId: input.proposal.proposalId, ...input.proposal.intent },
    policy: { decisionId: 'decision-1', effect: 'NEEDS_FACTS', policyVersion: input.policyVersion, inputFactsHash: hash, reasonCodes: ['DAMAGE_PHOTO_REVIEW_REQUIRED'], factRefs: [] },
  },
};

test('worker evidence calls preserve access and dedicated purposes, exact bindings and stable mutation idempotency', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const purposes: string[] = [];
  const client = createRefundEvidenceClient({
    baseUrl: 'http://human-operations.local', expectedTenantId: access.tenantId, expectedEnvironmentId: access.environmentId,
    async signWorkflowAccessAssertion(value) { assert.deepEqual(value.access, access); assert.equal(value.workflowId, input.workflowId); purposes.push(value.purpose); return 'signed-worker-assertion'; },
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init: init! });
      if (String(url).endsWith('/transition')) return Response.json({ refund_case: { case_id: 'case-1' } });
      if (String(url).endsWith('/close')) return Response.json({});
      return Response.json(snapshot());
    },
  });
  await client.openRefundEvidence(openInput);
  await client.readRefundEvidence(input);
  await client.transitionRefundEvidence({ ...openInput, caseType: 'REFUND_APPROVAL', evidenceVersion: 2 });
  await client.closeRefundEvidence({ ...input, caseId: 'case-1', outcome: 'EVIDENCE_REVIEW_COMPLETED' });
  assert.deepEqual(purposes, ['refund_evidence_open', 'refund_evidence_read', 'human_case_transition', 'human_case_close']);
  assert.equal(calls[0]!.url, 'http://human-operations.local/internal/v1/refund-evidence/collections');
  assert.equal(calls[1]!.url, 'http://human-operations.local/internal/v1/refund-evidence/refund-photo-1');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.order_id, 'order-1'); assert.equal(body.proposal_id, 'proposal-1'); assert.deepEqual(body.selected_item_ids, input.proposal.intent.itemIds); assert.equal(body.policy_version, input.policyVersion);
  assert.equal(Object.hasOwn(body, 'customer_id'), false);
  for (const call of calls) assert.equal(new Headers(call.init.headers).get('x-cso-workflow-assertion'), 'signed-worker-assertion');
  assert.equal(new Headers(calls[0]!.init.headers).get('idempotency-key'), `workflow:${input.workflowId}:evidence:open`);
  assert.equal(new Headers(calls[2]!.init.headers).get('idempotency-key'), `workflow:${input.workflowId}:evidence:transition:REFUND_APPROVAL:2`);
});

test('wrong tenant or environment fails before signing or any service request', async () => {
  let calls = 0;
  const client = createRefundEvidenceClient({ baseUrl: 'http://human-operations.local', expectedTenantId: access.tenantId, expectedEnvironmentId: access.environmentId,
    async signWorkflowAccessAssertion() { calls += 1; return 'never'; }, async fetchImpl() { calls += 1; return Response.json(snapshot()); } });
  for (const changed of [{ tenantId: 'other' }, { environmentId: 'other' }]) {
    await assert.rejects(client.readRefundEvidence({ ...input, access: { ...access, ...changed } }), /WORKFLOW_ACCESS_SCOPE_MISMATCH/);
  }
  assert.equal(calls, 0);
});

test('an unavailable evidence service never synthesizes accepted evidence', async () => {
  const client = createRefundEvidenceClient({ baseUrl: 'http://human-operations.local', expectedTenantId: access.tenantId, expectedEnvironmentId: access.environmentId,
    async signWorkflowAccessAssertion() { return 'assertion'; }, async fetchImpl() { return Response.json({ error: { code: 'unavailable' } }, { status: 503 }); } });
  await assert.rejects(client.readRefundEvidence(input), /REFUND_EVIDENCE_UNAVAILABLE_503/);
});
