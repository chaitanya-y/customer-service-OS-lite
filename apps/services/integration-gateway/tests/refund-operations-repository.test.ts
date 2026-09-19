import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Pool } from 'pg';

import { InMemoryRefundExecutionRepository, PostgresRefundExecutionRepository } from '../src/refund-execution-repository.js';

const INITIAL_TIME = '2026-09-17T12:00:00.000Z';

function reserveInput(idempotencyKey: string, occurredAt = INITIAL_TIME) {
  return {
    tenantId: 'tenant-local',
    environmentId: 'local',
    idempotencyKey,
    workflowId: `workflow-${idempotencyKey}`,
    previewId: `preview-${idempotencyKey}`,
    orderId: `order-${idempotencyKey}`,
    amountMinor: 5_000,
    currency: 'USD',
    occurredAt,
  };
}

function postgresSnapshotRepository(row: Record<string, unknown>): PostgresRefundExecutionRepository {
  return new PostgresRefundExecutionRepository({
    async query() {
      return { rows: [row] };
    },
  } as unknown as Pool);
}

function snapshotRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    in_progress_count: '0',
    submitted_count: '0',
    succeeded_count: '0',
    failed_count: '0',
    pending_reconciliation_count: '0',
    oldest_in_progress_age_seconds: null,
    oldest_submitted_age_seconds: null,
    oldest_pending_reconciliation_age_seconds: null,
    pending_provider_event_count: '0',
    oldest_pending_provider_event_age_seconds: null,
    ...overrides,
  };
}

test('Postgres snapshot rejects non-integer, non-finite, negative, and unsafe execution/provider counts while retaining finite ages', async () => {
  for (const invalidCount of ['1.5', 'NaN', '-1', String(Number.MAX_SAFE_INTEGER + 1)]) {
    await assert.rejects(
      postgresSnapshotRepository(snapshotRow({ in_progress_count: invalidCount, oldest_in_progress_age_seconds: '1' })).getRefundOperationsSnapshot(),
      { message: 'REFUND_OPERATIONS_SNAPSHOT_INVALID' },
    );
    await assert.rejects(
      postgresSnapshotRepository(snapshotRow({ pending_provider_event_count: invalidCount, oldest_pending_provider_event_age_seconds: '1' })).getRefundOperationsSnapshot(),
      { message: 'REFUND_OPERATIONS_SNAPSHOT_INVALID' },
    );
  }

  const snapshot = await postgresSnapshotRepository(snapshotRow({
    in_progress_count: '2',
    oldest_in_progress_age_seconds: '1.5',
    pending_provider_event_count: '3',
    oldest_pending_provider_event_age_seconds: '-4.25',
  })).getRefundOperationsSnapshot();

  assert.deepEqual(snapshot, {
    executionCounts: {
      IN_PROGRESS: 2,
      SUBMITTED: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      PENDING_RECONCILIATION: 0,
    },
    oldestExecutionAgeSeconds: { IN_PROGRESS: 1.5 },
    pendingProviderEventCount: 3,
    oldestPendingProviderEventAgeSeconds: 0,
  });
});

test('in-memory operational snapshot zero-fills every execution status and empty provider backlog', async () => {
  const repository = new InMemoryRefundExecutionRepository(() => new Date(INITIAL_TIME));

  const snapshot = await repository.getRefundOperationsSnapshot();

  assert.deepEqual(snapshot, {
    executionCounts: {
      IN_PROGRESS: 0,
      SUBMITTED: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      PENDING_RECONCILIATION: 0,
    },
    oldestExecutionAgeSeconds: {},
    pendingProviderEventCount: 0,
    oldestPendingProviderEventAgeSeconds: 0,
  });
});

test('in-memory operational snapshot uses status-entry time and oldest pending provider event time', async () => {
  let now = new Date(INITIAL_TIME);
  const repository = new InMemoryRefundExecutionRepository(() => now);
  const reserved = await repository.reserve(reserveInput('first'));
  assert.equal(reserved.kind, 'reserved');
  if (reserved.kind !== 'reserved') return;

  now = new Date('2026-09-17T12:05:00.000Z');
  await repository.recordOutcome(reserved.executionId, 'SUBMITTED', 'provider-refund-1');
  now = new Date('2026-09-17T12:07:00.000Z');
  await repository.recordProviderRefundEvent({
    eventId: 'provider-event-1',
    providerRefundId: 'provider-refund-1',
    outcome: 'COMPLETED',
    occurredAt: '2026-09-17T12:02:00.000Z',
  });

  const snapshot = await repository.getRefundOperationsSnapshot();

  assert.deepEqual(snapshot, {
    executionCounts: {
      IN_PROGRESS: 0,
      SUBMITTED: 0,
      SUCCEEDED: 1,
      FAILED: 0,
      PENDING_RECONCILIATION: 0,
    },
    oldestExecutionAgeSeconds: {},
    pendingProviderEventCount: 1,
    oldestPendingProviderEventAgeSeconds: 300,
  });
});

test('in-memory snapshot advances an active-state age from the status transition and does not reset it for the same status', async () => {
  let now = new Date(INITIAL_TIME);
  const repository = new InMemoryRefundExecutionRepository(() => now);
  const reserved = await repository.reserve(reserveInput('active'));
  assert.equal(reserved.kind, 'reserved');
  if (reserved.kind !== 'reserved') return;

  now = new Date('2026-09-17T12:05:00.000Z');
  await repository.recordOutcome(reserved.executionId, 'SUBMITTED');
  now = new Date('2026-09-17T12:07:00.000Z');
  await repository.recordOutcome(reserved.executionId, 'SUBMITTED');
  now = new Date('2026-09-17T12:09:00.000Z');

  const snapshot = await repository.getRefundOperationsSnapshot();

  assert.deepEqual(snapshot, {
    executionCounts: {
      IN_PROGRESS: 0,
      SUBMITTED: 1,
      SUCCEEDED: 0,
      FAILED: 0,
      PENDING_RECONCILIATION: 0,
    },
    oldestExecutionAgeSeconds: { SUBMITTED: 240 },
    pendingProviderEventCount: 0,
    oldestPendingProviderEventAgeSeconds: 0,
  });
});
