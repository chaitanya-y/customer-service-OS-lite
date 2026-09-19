import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { HumanCaseRepositoryError, InMemoryHumanCaseRepository } from '../src/human-case-repository.js';
import { PostgresHumanCaseRepository, toPendingDecisionOutboxSnapshot } from '../src/postgres-human-case-repository.js';

const databaseUrl = process.env.HUMAN_OPERATIONS_TEST_DATABASE_URL;

test(
  'persists a tenant-scoped decision, audit history, idempotency result, and outbox event together',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new PostgresHumanCaseRepository(pool);
    const tenantId = `test-tenant-${randomUUID()}`;
    const environmentId = 'local';

    try {
      const opened = await repository.open({
        tenantId,
        environmentId,
        workflowId: `refund-${randomUUID()}`,
        caseType: 'REFUND_APPROVAL',
        reviewPacket: {
          order_reference: 'ORDER-001',
          policy_reason_codes: ['REVIEW_REQUIRED'],
          evidence_ids: ['evidence-001'],
          policy_version: 'refund-policy-v1',
        },
        policyVersion: 'refund-policy-v1',
      });
      assert.equal(opened.status, 'OPEN');

      await assert.rejects(
        repository.get({ caseId: opened.caseId, tenantId: `${tenantId}-other`, environmentId }),
        (error: unknown) => error instanceof HumanCaseRepositoryError && error.code === 'CASE_NOT_FOUND',
      );

      const claimed = await repository.claim({
        caseId: opened.caseId,
        tenantId,
        environmentId,
        staffId: 'approver-001',
        expectedCaseVersion: opened.caseVersion,
        idempotencyKey: `claim-${randomUUID()}`,
      });
      const idempotencyKey = `decision-${randomUUID()}`;
      const decision = await repository.decide({
        caseId: opened.caseId,
        tenantId,
        environmentId,
        staffId: 'approver-001',
        decision: 'APPROVE',
        reasonCode: 'POLICY_REVIEW_APPROVED',
        expectedCaseVersion: claimed.caseVersion,
        idempotencyKey,
      });
      assert.equal(decision.case.status, 'DECISION_PENDING');
      assert.equal(await repository.isOutboxPending({ eventId: decision.outboxEvent.eventId, tenantId, environmentId }), true);

      const replay = await repository.decide({
        caseId: opened.caseId,
        tenantId,
        environmentId,
        staffId: 'approver-001',
        decision: 'APPROVE',
        reasonCode: 'POLICY_REVIEW_APPROVED',
        expectedCaseVersion: claimed.caseVersion,
        idempotencyKey,
      });
      assert.equal(replay.outboxEvent.eventId, decision.outboxEvent.eventId);

      const auditEvents = await repository.auditEvents({ caseId: opened.caseId, tenantId, environmentId });
      assert.deepEqual(auditEvents.map((event) => event.eventType), ['CASE_OPENED', 'CASE_CLAIMED', 'DECISION_RECORDED']);

      await repository.markOutboxDelivered({ eventId: decision.outboxEvent.eventId, tenantId, environmentId });
      assert.equal(await repository.isOutboxPending({ eventId: decision.outboxEvent.eventId, tenantId, environmentId }), false);
    } finally {
      await pool.end();
    }
  },
);

test('reports a deterministic scoped pending decision-outbox snapshot in memory', async () => {
  let currentTime = new Date('2026-09-17T12:00:00.000Z');
  let id = 0;
  const repository = new InMemoryHumanCaseRepository(() => currentTime, () => String(++id));
  const first = await createPendingDecision(repository, 'tenant-a', 'local', 'first');
  currentTime = new Date('2026-09-17T12:00:30.000Z');
  const second = await createPendingDecision(repository, 'tenant-a', 'local', 'second');
  await createPendingDecision(repository, 'tenant-b', 'local', 'other-tenant');
  currentTime = new Date('2026-09-17T12:01:00.000Z');

  assert.deepEqual(
    await repository.getPendingDecisionOutboxSnapshot({ tenantId: 'tenant-a', environmentId: 'local' }),
    { pendingCount: 2, oldestPendingAgeSeconds: 60 },
  );
  await repository.markOutboxDelivered({ eventId: first.outboxEvent.eventId, tenantId: 'tenant-a', environmentId: 'local' });
  assert.deepEqual(
    await repository.getPendingDecisionOutboxSnapshot({ tenantId: 'tenant-a', environmentId: 'local' }),
    { pendingCount: 1, oldestPendingAgeSeconds: 30 },
  );
  await repository.markOutboxDelivered({ eventId: second.outboxEvent.eventId, tenantId: 'tenant-a', environmentId: 'local' });
  assert.deepEqual(
    await repository.getPendingDecisionOutboxSnapshot({ tenantId: 'tenant-a', environmentId: 'local' }),
    { pendingCount: 0, oldestPendingAgeSeconds: 0 },
  );
});

test('rejects unsafe pending-outbox aggregate values from PostgreSQL', () => {
  assert.deepEqual(
    toPendingDecisionOutboxSnapshot({ pending_count: '2', oldest_pending_age_seconds: '1.5' }),
    { pendingCount: 2, oldestPendingAgeSeconds: 1.5 },
  );
  for (const pendingCount of ['-1', '1.5', 'Infinity', String(Number.MAX_SAFE_INTEGER + 1)]) {
    assert.throws(() => toPendingDecisionOutboxSnapshot({ pending_count: pendingCount, oldest_pending_age_seconds: 0 }));
  }
  for (const oldestPendingAgeSeconds of ['-1', 'Infinity']) {
    assert.throws(() => toPendingDecisionOutboxSnapshot({ pending_count: 0, oldest_pending_age_seconds: oldestPendingAgeSeconds }));
  }
});

test(
  'reports the RLS-scoped PostgreSQL pending decision-outbox aggregate and reduces it after delivery',
  { skip: databaseUrl ? false : 'HUMAN_OPERATIONS_TEST_DATABASE_URL is not set' },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new PostgresHumanCaseRepository(pool);
    const tenantId = `test-tenant-${randomUUID()}`;
    const environmentId = 'local';
    try {
      const first = await createPendingDecision(repository, tenantId, environmentId, 'first');
      await createPendingDecision(repository, tenantId, environmentId, 'second');
      await createPendingDecision(repository, `${tenantId}-other`, environmentId, 'other-tenant');

      const beforeDelivery = await repository.getPendingDecisionOutboxSnapshot({ tenantId, environmentId });
      assert.equal(beforeDelivery.pendingCount, 2);
      assert.ok(Number.isFinite(beforeDelivery.oldestPendingAgeSeconds));
      assert.ok(beforeDelivery.oldestPendingAgeSeconds >= 0);

      await repository.markOutboxDelivered({ eventId: first.outboxEvent.eventId, tenantId, environmentId });
      const afterFirstDelivery = await repository.getPendingDecisionOutboxSnapshot({ tenantId, environmentId });
      assert.equal(afterFirstDelivery.pendingCount, 1);
      assert.ok(Number.isFinite(afterFirstDelivery.oldestPendingAgeSeconds));
      assert.ok(afterFirstDelivery.oldestPendingAgeSeconds >= 0);
      const remaining = (await repository.listPendingOutbox({ tenantId, environmentId, limit: 1 }))[0];
      assert.ok(remaining);
      await repository.markOutboxDelivered({ eventId: remaining.eventId, tenantId, environmentId });
      assert.deepEqual(await repository.getPendingDecisionOutboxSnapshot({ tenantId, environmentId }), { pendingCount: 0, oldestPendingAgeSeconds: 0 });
    } finally {
      await pool.end();
    }
  },
);

async function createPendingDecision(
  repository: Pick<InMemoryHumanCaseRepository | PostgresHumanCaseRepository, 'open' | 'claim' | 'decide'>,
  tenantId: string,
  environmentId: string,
  suffix: string,
) {
  const opened = await repository.open({
    tenantId,
    environmentId,
    workflowId: `refund-${suffix}-${randomUUID()}`,
    caseType: 'REFUND_APPROVAL',
    reviewPacket: {
      order_reference: `ORDER-${suffix}`,
      policy_reason_codes: ['REVIEW_REQUIRED'],
      evidence_ids: ['evidence-001'],
      policy_version: 'refund-policy-v1',
    },
    policyVersion: 'refund-policy-v1',
  });
  const claimed = await repository.claim({
    caseId: opened.caseId,
    tenantId,
    environmentId,
    staffId: 'approver-001',
    expectedCaseVersion: opened.caseVersion,
    idempotencyKey: `claim-${suffix}-${randomUUID()}`,
  });
  return repository.decide({
    caseId: opened.caseId,
    tenantId,
    environmentId,
    staffId: 'approver-001',
    decision: 'APPROVE',
    expectedCaseVersion: claimed.caseVersion,
    idempotencyKey: `decision-${suffix}-${randomUUID()}`,
  });
}
