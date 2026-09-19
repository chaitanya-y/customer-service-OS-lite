import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RefundOperationsSnapshot } from '../src/refund-execution-repository.js';
import { createRefundOperationsObserver } from '../src/refund-operations-observer.js';

type Gauge = Readonly<{ name: string; value: number; outcome?: string }>;

class ManualScheduler {
  delayMilliseconds: number | undefined;
  unrefCalls = 0;
  private callback: (() => void) | undefined;

  setInterval(callback: () => void, delayMilliseconds: number): NodeJS.Timeout {
    this.callback = callback;
    this.delayMilliseconds = delayMilliseconds;
    return { unref: () => { this.unrefCalls += 1; } } as unknown as NodeJS.Timeout;
  }

  clearInterval(): void {
    this.callback = undefined;
  }

  fire(): void {
    this.callback?.();
  }
}

const snapshot: RefundOperationsSnapshot = {
  executionCounts: {
    IN_PROGRESS: 2,
    SUBMITTED: 1,
    SUCCEEDED: 4,
    FAILED: 3,
    PENDING_RECONCILIATION: 5,
  },
  oldestExecutionAgeSeconds: {
    IN_PROGRESS: 11,
    SUBMITTED: 22,
    PENDING_RECONCILIATION: 33,
  },
  pendingProviderEventCount: 6,
  oldestPendingProviderEventAgeSeconds: 44,
};

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('observer immediately maps an authoritative snapshot to the fixed operational gauges', async () => {
  const gauges: Gauge[] = [];
  const scheduler = new ManualScheduler();
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { return snapshot; } },
    telemetry: { enabled: true, recordOperationalGauge(observation) { gauges.push(observation); } },
    scheduler,
  });

  observer.start();
  await settle();
  observer.stop();

  assert.equal(scheduler.delayMilliseconds, 30_000);
  assert.equal(scheduler.unrefCalls, 1);
  assert.deepEqual(gauges, [
    { name: 'cso.refund.executions.current', value: 2, outcome: 'IN_PROGRESS' },
    { name: 'cso.refund.executions.current', value: 1, outcome: 'SUBMITTED' },
    { name: 'cso.refund.executions.current', value: 4, outcome: 'SUCCEEDED' },
    { name: 'cso.refund.executions.current', value: 3, outcome: 'FAILED' },
    { name: 'cso.refund.executions.current', value: 5, outcome: 'PENDING_RECONCILIATION' },
    { name: 'cso.refund.executions.oldest_age', value: 11, outcome: 'IN_PROGRESS' },
    { name: 'cso.refund.executions.oldest_age', value: 22, outcome: 'SUBMITTED' },
    { name: 'cso.refund.executions.oldest_age', value: 33, outcome: 'PENDING_RECONCILIATION' },
    { name: 'cso.refund.provider_events.pending', value: 6 },
    { name: 'cso.refund.provider_events.oldest_age', value: 44 },
  ]);
});

test('disabled telemetry performs no snapshot observation or scheduling', async () => {
  let observations = 0;
  const scheduler = new ManualScheduler();
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { observations += 1; return snapshot; } },
    telemetry: { enabled: false, recordOperationalGauge() { assert.fail('disabled telemetry must not record gauges'); } },
    scheduler,
  });

  observer.start();
  await settle();
  scheduler.fire();
  await settle();
  observer.stop();

  assert.equal(observations, 0);
  assert.equal(scheduler.delayMilliseconds, undefined);
});

test('observer suppresses overlapping scheduled observations', async () => {
  let observations = 0;
  let release: (() => void) | undefined;
  const blockedSnapshot = new Promise<RefundOperationsSnapshot>((resolve) => { release = () => resolve(snapshot); });
  const scheduler = new ManualScheduler();
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { observations += 1; return blockedSnapshot; } },
    telemetry: { enabled: true, recordOperationalGauge() {} },
    scheduler,
  });

  observer.start();
  scheduler.fire();
  scheduler.fire();
  assert.equal(observations, 1);
  release?.();
  await settle();
  scheduler.fire();
  assert.equal(observations, 2);
  observer.stop();
});

test('observer emits a fixed safe diagnostic when snapshot observation fails', async () => {
  const diagnostics: string[] = [];
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { throw new Error('customer-42 provider payload must not be logged'); } },
    telemetry: { enabled: true, recordOperationalGauge() { assert.fail('failed observation must not record gauges'); } },
    diagnostic(message) { diagnostics.push(message); },
    scheduler: new ManualScheduler(),
  });

  observer.start();
  await settle();
  observer.stop();

  assert.deepEqual(diagnostics, ['refund.operations_observation_failed']);
});

test('observer stop clears scheduled work before repository shutdown', async () => {
  let observations = 0;
  const scheduler = new ManualScheduler();
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { observations += 1; return snapshot; } },
    telemetry: { enabled: true, recordOperationalGauge() {} },
    scheduler,
  });

  observer.start();
  await settle();
  observer.stop();
  scheduler.fire();
  await settle();

  assert.equal(observations, 1);
});

test('observer does not publish a resolved in-flight snapshot after stop', async () => {
  let release: ((value: RefundOperationsSnapshot) => void) | undefined;
  const inFlightSnapshot = new Promise<RefundOperationsSnapshot>((resolve) => { release = resolve; });
  const gauges: Gauge[] = [];
  const observer = createRefundOperationsObserver({
    repository: { async getRefundOperationsSnapshot() { return inFlightSnapshot; } },
    telemetry: { enabled: true, recordOperationalGauge(observation) { gauges.push(observation); } },
    scheduler: new ManualScheduler(),
  });

  observer.start();
  observer.stop();
  release?.(snapshot);
  await settle();

  assert.deepEqual(gauges, []);
});
