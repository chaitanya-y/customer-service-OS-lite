import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { InMemoryHumanCaseRepository } from '../src/human-case-repository.js';
import { HUMAN_ASSERTION_HEADER } from '../src/human-access.js';
import { WORKFLOW_ASSERTION_HEADER } from '../src/workflow-access.js';

const approver = { staffId: 'approver-001', tenantId: 'tenant-local', environmentId: 'local', role: 'REFUND_APPROVER' as const, iss: 'human-operations', aud: 'human-operations' };
const supervisor = { staffId: 'supervisor-001', tenantId: 'tenant-local', environmentId: 'local', role: 'REFUND_SUPERVISOR' as const, iss: 'human-operations', aud: 'human-operations' };

function createApp() {
  let identifier = 0;
  const repository = new InMemoryHumanCaseRepository(
    () => new Date('2026-08-22T12:00:00.000Z'),
    () => `${++identifier}`,
  );
  const sent: unknown[] = [];
  const app = buildApp({
    repository,
    async verifyHuman(assertion) {
      if (assertion === 'approver') return approver;
      if (assertion === 'supervisor') return supervisor;
      throw new Error('unauthorized');
    },
    async verifyWorkflowCaseAccess(assertion, purpose) {
      if (assertion !== 'workflow-assertion') throw new Error('unauthorized');
      return { workflowId: 'refund-001', tenantId: 'tenant-local', environmentId: 'local', subjectCustomerId: 'customer-001', purpose };
    },
    async sendDecision(input) { sent.push(input); },
  });
  return { app, sent };
}

async function openCase(app: ReturnType<typeof buildApp>, caseType: 'REFUND_APPROVAL' | 'REFUND_TAKEOVER') {
  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-cases',
    headers: { [WORKFLOW_ASSERTION_HEADER]: 'workflow-assertion', 'idempotency-key': 'open-case-001' },
    payload: {
      workflow_id: 'refund-001',
      case_type: caseType,
      policy_version: 'refund-policy-v1',
      review_packet: { order_reference: 'ORDER-001', policy_reason_codes: ['REVIEW_REQUIRED'], evidence_ids: ['evidence-001'], policy_version: 'refund-policy-v1' },
    },
  });
  assert.equal(response.statusCode, 201);
  return JSON.parse(response.body).refund_case as { case_id: string; case_version: number; allowed_actions: string[] };
}

test('worker assertion opens one idempotent tenant-scoped approval case', async (context) => {
  const { app } = createApp();
  context.after(() => app.close());
  const first = await openCase(app, 'REFUND_APPROVAL');
  const second = await openCase(app, 'REFUND_APPROVAL');
  assert.equal(first.case_id, second.case_id);
  assert.deepEqual(first.allowed_actions, ['APPROVE', 'REJECT']);
});

test('approval requires claimed case, an idempotency key, and a matching approver role', async (context) => {
  const { app, sent } = createApp();
  context.after(() => app.close());
  const humanCase = await openCase(app, 'REFUND_APPROVAL');

  const missingKey = await app.inject({ method: 'POST', url: `/v1/refund-cases/${humanCase.case_id}/claim`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver' }, payload: { expected_case_version: 1 } });
  assert.equal(missingKey.statusCode, 400);

  const claimed = await app.inject({ method: 'POST', url: `/v1/refund-cases/${humanCase.case_id}/claim`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver', 'idempotency-key': 'claim-case-001' }, payload: { expected_case_version: 1 } });
  assert.equal(claimed.statusCode, 200);
  assert.equal(JSON.parse(claimed.body).refund_case.case_version, 2);

  const decision = await app.inject({ method: 'POST', url: `/v1/refund-cases/${humanCase.case_id}/decision`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver', 'idempotency-key': 'decision-case-001' }, payload: { decision: 'APPROVE', reason_code: 'POLICY_REVIEW_APPROVED', expected_case_version: 2 } });
  assert.equal(decision.statusCode, 202);
  assert.equal(JSON.parse(decision.body).refund_case.status, 'DECISION_PENDING');
  assert.equal(sent.length, 1);

  const replay = await app.inject({ method: 'POST', url: `/v1/refund-cases/${humanCase.case_id}/decision`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver', 'idempotency-key': 'decision-case-001' }, payload: { decision: 'APPROVE', reason_code: 'POLICY_REVIEW_APPROVED', expected_case_version: 2 } });
  assert.equal(replay.statusCode, 202);
  assert.equal(sent.length, 1);
});

test('an approver cannot access or decide a takeover case', async (context) => {
  const { app } = createApp();
  context.after(() => app.close());
  const humanCase = await openCase(app, 'REFUND_TAKEOVER');
  const detail = await app.inject({ method: 'GET', url: `/v1/refund-cases/${humanCase.case_id}`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver' } });
  assert.equal(detail.statusCode, 404);
  const claim = await app.inject({ method: 'POST', url: `/v1/refund-cases/${humanCase.case_id}/claim`, headers: { [HUMAN_ASSERTION_HEADER]: 'approver', 'idempotency-key': 'claim-case-002' }, payload: { expected_case_version: 1 } });
  assert.equal(claim.statusCode, 403);
});

test('workflow calls must be authorized and match the signed workflow identity', async (context) => {
  const { app } = createApp();
  context.after(() => app.close());
  const missingAssertion = await app.inject({ method: 'POST', url: '/internal/v1/refund-cases', headers: { 'idempotency-key': 'open-case-003' }, payload: { workflow_id: 'refund-001', case_type: 'REFUND_TAKEOVER', policy_version: 'refund-policy-v1', review_packet: { policy_reason_codes: [], evidence_ids: [], policy_version: 'refund-policy-v1' } } });
  assert.equal(missingAssertion.statusCode, 401);
  const mismatch = await app.inject({ method: 'POST', url: '/internal/v1/refund-cases', headers: { [WORKFLOW_ASSERTION_HEADER]: 'workflow-assertion', 'idempotency-key': 'open-case-004' }, payload: { workflow_id: 'refund-other', case_type: 'REFUND_TAKEOVER', policy_version: 'refund-policy-v1', review_packet: { policy_reason_codes: [], evidence_ids: [], policy_version: 'refund-policy-v1' } } });
  assert.equal(mismatch.statusCode, 403);
});
