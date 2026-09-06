import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkflowNotFoundError, type WorkflowClient } from '@temporalio/client';

import {
  createTemporalRefundClient,
  RefundPreviewUnavailableError,
  RefundWorkflowNotFoundError,
  type RefundWorkflowView,
} from '../src/temporal-refund-client.js';

const access = {
  tenantId: 'tenant-local',
  environmentId: 'local',
  subjectCustomerId: 'customer-42',
  requestId: 'request-001',
  traceId: 'trace-001',
};
const confirmation = {
  workflowId: 'refund-001',
  access,
  previewId: 'preview-001',
  accepted: true,
};
const ready: RefundWorkflowView = {
  stage: 'AWAITING_CUSTOMER_CONFIRMATION',
  preview: {
    previewId: 'preview-001',
    requestedAmount: { amountMinor: 5_000, currency: 'USD' },
    refundDestination: 'ORIGINAL_PAYMENT_METHOD',
    // Intentionally before the fake Edge clock: only the workflow judges expiry.
    validUntil: '2026-08-08T12:15:00.000Z',
  },
};
const confirmedAt = '2026-09-05T12:34:56.789Z';

function makeClient(options: {
  owner?: typeof access;
  accessError?: Error;
  states?: readonly (RefundWorkflowView | Error)[];
  signalError?: Error;
} = {}) {
  const calls: string[] = [];
  const signals: unknown[][] = [];
  const states = options.states ?? [ready];
  let stateQueries = 0;
  let clockCalls = 0;
  const client = {
    getHandle(workflowId: string) {
      calls.push(`getHandle:${workflowId}`);
      return {
        async query(name: string) {
          calls.push(`query:${name}`);
          if (name === 'refund.access') {
            if (options.accessError) throw options.accessError;
            return options.owner ?? access;
          }
          assert.equal(name, 'refund.state');
          const state = states[stateQueries++];
          assert.ok(state, 'Unexpected extra workflow-state query');
          if (state instanceof Error) throw state;
          return state;
        },
        async signal(...args: unknown[]) {
          calls.push('signal:refund.confirmation');
          signals.push(args);
          if (options.signalError) throw options.signalError;
        },
      };
    },
  } as unknown as WorkflowClient;

  return {
    ...createTemporalRefundClient({
      client,
      taskQueue: 'refund-tests',
      now: () => {
        clockCalls += 1;
        return new Date(confirmedAt);
      },
    }),
    calls,
    signals,
    get clockCalls() { return clockCalls; },
  };
}

test('confirmation checks every ownership dimension before reading state or signaling', async () => {
  for (const dimension of ['tenantId', 'environmentId', 'subjectCustomerId'] as const) {
    const client = makeClient({ owner: { ...access, [dimension]: 'another-owner' } });

    await assert.rejects(client.confirmRefundWorkflow(confirmation), RefundWorkflowNotFoundError);

    assert.deepEqual(client.calls, ['getHandle:refund-001', 'query:refund.access']);
    assert.equal(client.signals.length, 0);
    assert.equal(client.clockCalls, 0);
  }
});

test('confirmation rejects a stale preview ID or a missing current preview', async () => {
  for (const state of [
    { ...ready, preview: { ...ready.preview!, previewId: 'preview-new' } },
    { stage: 'AWAITING_CUSTOMER_CONFIRMATION' },
  ]) {
    const client = makeClient({ states: [state] });

    await assert.rejects(client.confirmRefundWorkflow(confirmation), RefundPreviewUnavailableError);

    assert.deepEqual(client.calls, ['getHandle:refund-001', 'query:refund.access', 'query:refund.state']);
    assert.equal(client.signals.length, 0);
    assert.equal(client.clockCalls, 0);
  }
});

test('confirmation rejects expired, terminal, and other non-confirmation workflow stages', async () => {
  for (const stage of [
    'PREVIEW_EXPIRED', 'PREVIEW_INVALIDATED', 'REFUND_SUCCEEDED', 'REFUND_FAILED',
    'CANCELLED', 'DENIED', 'REJECTED', 'TAKEOVER_RESOLVED', 'AWAITING_APPROVAL',
    'HUMAN_TAKEOVER_REQUIRED', 'REFUND_PROCESSING', 'PENDING_RECONCILIATION', 'EVALUATING',
  ]) {
    const client = makeClient({ states: [{ ...ready, stage }] });

    await assert.rejects(client.confirmRefundWorkflow(confirmation), RefundPreviewUnavailableError);

    assert.equal(client.signals.length, 0);
    assert.equal(client.clockCalls, 0);
  }
});

test('valid confirmation or decline signals exactly once without authorizing expiry by the Edge clock', async () => {
  for (const accepted of [true, false]) {
    const client = makeClient();

    await client.confirmRefundWorkflow({ ...confirmation, accepted });

    assert.deepEqual(client.calls, [
      'getHandle:refund-001', 'query:refund.access', 'query:refund.state', 'signal:refund.confirmation',
    ]);
    assert.deepEqual(client.signals, [[
      'refund.confirmation', { previewId: 'preview-001', accepted, confirmedAt },
    ]]);
    assert.equal(client.clockCalls, 1);
  }
});

test('a completion race becomes unavailable only after requery confirms the changed state', async () => {
  for (const stage of ['PREVIEW_EXPIRED', 'CANCELLED', 'REFUND_SUCCEEDED']) {
    const client = makeClient({
      states: [ready, { ...ready, stage }],
      signalError: new WorkflowNotFoundError('Workflow execution already completed', 'refund-001', undefined),
    });

    await assert.rejects(client.confirmRefundWorkflow(confirmation), RefundPreviewUnavailableError);

    assert.deepEqual(client.calls, [
      'getHandle:refund-001', 'query:refund.access', 'query:refund.state',
      'signal:refund.confirmation', 'query:refund.state',
    ]);
    assert.equal(client.signals.length, 1);
  }
});

test('a not-found signal error remains an error if the current preview is still confirmable', async () => {
  const error = new WorkflowNotFoundError('Workflow could not be found', 'refund-001', undefined);
  const client = makeClient({ states: [ready, ready], signalError: error });

  await assert.rejects(client.confirmRefundWorkflow(confirmation), (received) => received === error);

  assert.equal(client.signals.length, 1);
});

test('confirmation propagates ownership-query transport failures without reading state or signaling', async () => {
  const error = new Error('Temporal ownership query timed out');
  const client = makeClient({ accessError: error });

  await assert.rejects(client.confirmRefundWorkflow(confirmation), (received) => received === error);

  assert.deepEqual(client.calls, ['getHandle:refund-001', 'query:refund.access']);
  assert.equal(client.signals.length, 0);
});

test('confirmation propagates state-query transport failures without signaling', async () => {
  const error = new Error('Temporal state query timed out');
  const client = makeClient({ states: [error] });

  await assert.rejects(client.confirmRefundWorkflow(confirmation), (received) => received === error);

  assert.equal(client.signals.length, 0);
  assert.equal(client.clockCalls, 0);
});

test('confirmation propagates unrelated signal failures without retrying or requerying', async () => {
  const error = new Error('Temporal signal connection failed');
  const client = makeClient({ signalError: error });

  await assert.rejects(client.confirmRefundWorkflow(confirmation), (received) => received === error);

  assert.deepEqual(client.calls, [
    'getHandle:refund-001', 'query:refund.access', 'query:refund.state', 'signal:refund.confirmation',
  ]);
  assert.equal(client.signals.length, 1);
});

test('confirmation does not disguise a failed completion-race requery as an expired preview', async () => {
  const error = new Error('Temporal completion-state query timed out');
  const client = makeClient({
    states: [ready, error],
    signalError: new WorkflowNotFoundError('Workflow execution already completed', 'refund-001', undefined),
  });

  await assert.rejects(client.confirmRefundWorkflow(confirmation), (received) => received === error);

  assert.equal(client.signals.length, 1);
});
