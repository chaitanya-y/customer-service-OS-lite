import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startDecisionOutboxObserver } from '../src/decision-outbox-observer.js';

const scope = { tenantId: 'tenant-local', environmentId: 'local' };

test('observes the decision outbox immediately with exact unlabelled gauges', async () => {
  const gauges: unknown[] = [];
  const scheduler = new ManualScheduler();
  const observer = startDecisionOutboxObserver({
    repository: { async getPendingDecisionOutboxSnapshot() { return { pendingCount: 3, oldestPendingAgeSeconds: 42 }; } },
    telemetry: { enabled: true, recordOperationalGauge(observation: unknown) { gauges.push(observation); } },
    ...scope,
    scheduler,
  });

  await settle();
  assert.deepEqual(gauges, [
    { name: 'cso.human_operations.decision_outbox.pending', value: 3 },
    { name: 'cso.human_operations.decision_outbox.oldest_age', value: 42 },
  ]);
  assert.equal(scheduler.delay, 30_000);
  assert.equal(scheduler.unrefCalls, 1);
  observer.stop();
});

test('does nothing when telemetry is disabled', async () => {
  let reads = 0;
  const scheduler = new ManualScheduler();
  const observer = startDecisionOutboxObserver({
    repository: { async getPendingDecisionOutboxSnapshot() { reads++; return { pendingCount: 3, oldestPendingAgeSeconds: 42 }; } },
    telemetry: { enabled: false, recordOperationalGauge() { throw new Error('must not emit'); } },
    ...scope,
    scheduler,
  });

  await settle();
  assert.equal(reads, 0);
  assert.equal(scheduler.delay, undefined);
  observer.stop();
});

test('suppresses overlapping outbox observations', async () => {
  let resolveSnapshot: ((value: { pendingCount: number; oldestPendingAgeSeconds: number }) => void) | undefined;
  let reads = 0;
  const scheduler = new ManualScheduler();
  const observer = startDecisionOutboxObserver({
    repository: { getPendingDecisionOutboxSnapshot() { reads++; return new Promise((resolve) => { resolveSnapshot = resolve; }); } },
    telemetry: { enabled: true, recordOperationalGauge() {} },
    ...scope,
    scheduler,
  });

  scheduler.run();
  scheduler.run();
  assert.equal(reads, 1);
  resolveSnapshot?.({ pendingCount: 0, oldestPendingAgeSeconds: 0 });
  await settle();
  scheduler.run();
  assert.equal(reads, 2);
  observer.stop();
});

test('uses a fixed safe diagnostic when observation fails', async () => {
  const diagnostics: string[] = [];
  const observer = startDecisionOutboxObserver({
    repository: { async getPendingDecisionOutboxSnapshot() { throw new Error('tenant=secret cannot connect'); } },
    telemetry: { enabled: true, recordOperationalGauge() {} },
    ...scope,
    diagnostic(message: string) { diagnostics.push(message); },
  });

  await settle();
  assert.deepEqual(diagnostics, ['human-operations.decision_outbox.observation_deferred']);
  observer.stop();
});

test('emits the fixed safe diagnostic by default when observation fails', async () => {
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const observer = startDecisionOutboxObserver({
      repository: { async getPendingDecisionOutboxSnapshot() { throw new Error('tenant=secret cannot connect'); } },
      telemetry: { enabled: true, recordOperationalGauge() {} },
      ...scope,
    });
    await settle();
    observer.stop();
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, [['human-operations.decision_outbox.observation_deferred']]);
});

test('stops and clears the independent observer timer', () => {
  const scheduler = new ManualScheduler();
  const observer = startDecisionOutboxObserver({
    repository: { async getPendingDecisionOutboxSnapshot() { return { pendingCount: 0, oldestPendingAgeSeconds: 0 }; } },
    telemetry: { enabled: true, recordOperationalGauge() {} },
    ...scope,
    scheduler,
  });

  observer.stop();
  observer.stop();
  assert.equal(scheduler.clearCalls, 1);
});

test('does not publish an observation that completes after stop', async () => {
  let resolveSnapshot: ((value: { pendingCount: number; oldestPendingAgeSeconds: number }) => void) | undefined;
  const gauges: unknown[] = [];
  const observer = startDecisionOutboxObserver({
    repository: { getPendingDecisionOutboxSnapshot() { return new Promise((resolve) => { resolveSnapshot = resolve; }); } },
    telemetry: { enabled: true, recordOperationalGauge(observation: unknown) { gauges.push(observation); } },
    ...scope,
  });

  observer.stop();
  resolveSnapshot?.({ pendingCount: 1, oldestPendingAgeSeconds: 1 });
  await settle();
  assert.deepEqual(gauges, []);
});

class ManualScheduler {
  callback: (() => void) | undefined;
  delay: number | undefined;
  clearCalls = 0;
  unrefCalls = 0;

  setInterval(callback: () => void, delay: number) {
    this.callback = callback;
    this.delay = delay;
    return { unref: () => { this.unrefCalls++; } };
  }

  clearInterval() { this.clearCalls++; }

  run() { this.callback?.(); }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
