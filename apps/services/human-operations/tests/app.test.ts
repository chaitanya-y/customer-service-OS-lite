import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../src/app.js';
import { HUMAN_ASSERTION_HEADER } from '../src/human-access.js';

const access = {
  staffId: 'agent-001',
  tenantId: 'tenant-local',
  environmentId: 'local',
  role: 'REFUND_APPROVER' as const,
  iss: 'human-operations',
  aud: 'human-operations',
};

test('derives the approver identity from the assertion, not request JSON', async (context) => {
  const app = buildApp({
    async verifyHuman(assertion) {
      assert.equal(assertion, 'signed-human');
      return access;
    },
    async sendDecision(input) {
      assert.deepEqual(input, {
        workflowId: 'refund-001',
        access,
        decision: 'APPROVE',
        reasonCode: 'VALID_REQUEST',
      });
    },
  });
  context.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/internal/v1/refund-workflows/refund-001/decision',
    headers: { [HUMAN_ASSERTION_HEADER]: 'signed-human' },
    payload: { decision: 'APPROVE', reasonCode: 'VALID_REQUEST', decidedBy: 'spoofed-user' },
  });

  assert.equal(response.statusCode, 400);
});

test('forwards a valid authorized decision', async (context) => {
  let received = false;
  const app = buildApp({
    async verifyHuman() { return access; },
    async sendDecision(input) { received = input.decision === 'REJECT' && input.access.staffId === 'agent-001'; },
  });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/internal/v1/refund-workflows/refund-001/decision', headers: { [HUMAN_ASSERTION_HEADER]: 'signed-human' }, payload: { decision: 'REJECT' } });
  assert.equal(response.statusCode, 202);
  assert.equal(received, true);
});

test('rejects a request without human authorization', async (context) => {
  const app = buildApp({ async verifyHuman() { throw new Error('no'); }, async sendDecision() { throw new Error('not reached'); } });
  context.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/internal/v1/refund-workflows/refund-001/decision', payload: { decision: 'APPROVE' } });
  assert.equal(response.statusCode, 401);
});
