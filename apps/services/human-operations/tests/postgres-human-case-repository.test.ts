import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { Pool } from 'pg';

import { HumanCaseRepositoryError } from '../src/human-case-repository.js';
import { PostgresHumanCaseRepository } from '../src/postgres-human-case-repository.js';

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
