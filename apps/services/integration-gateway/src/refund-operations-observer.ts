import type { TelemetryHandle } from '@cso/observability-node';

import type { RefundExecutionRepository } from './refund-execution-repository.js';

const OBSERVATION_INTERVAL_MILLISECONDS = 30_000;
const executionStatuses = ['IN_PROGRESS', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION'] as const;
const activeExecutionStatuses = ['IN_PROGRESS', 'SUBMITTED', 'PENDING_RECONCILIATION'] as const;

type IntervalScheduler = Readonly<{
  setInterval(callback: () => void, delayMilliseconds: number): NodeJS.Timeout;
  clearInterval(interval: NodeJS.Timeout): void;
}>;

export type RefundOperationsObserver = Readonly<{
  start(): void;
  stop(): void;
}>;

export function createRefundOperationsObserver(input: Readonly<{
  repository: RefundExecutionRepository;
  telemetry: TelemetryHandle;
  diagnostic?: (message: 'refund.operations_observation_failed') => void;
  scheduler?: IntervalScheduler;
}>): RefundOperationsObserver {
  const scheduler = input.scheduler ?? globalThis;
  const diagnostic = input.diagnostic ?? ((message: 'refund.operations_observation_failed') => console.error(message));
  let interval: NodeJS.Timeout | undefined;
  let observing = false;
  let stopped = false;
  let started = false;

  const observe = async (): Promise<void> => {
    if (stopped || observing || !input.telemetry.enabled) return;
    observing = true;
    try {
      const snapshot = await input.repository.getRefundOperationsSnapshot();
      if (stopped) return;
      for (const outcome of executionStatuses) {
        input.telemetry.recordOperationalGauge({
          name: 'cso.refund.executions.current',
          value: snapshot.executionCounts[outcome],
          outcome,
        });
      }
      for (const outcome of activeExecutionStatuses) {
        input.telemetry.recordOperationalGauge({
          name: 'cso.refund.executions.oldest_age',
          value: snapshot.oldestExecutionAgeSeconds[outcome] ?? 0,
          outcome,
        });
      }
      input.telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.pending', value: snapshot.pendingProviderEventCount });
      input.telemetry.recordOperationalGauge({ name: 'cso.refund.provider_events.oldest_age', value: snapshot.oldestPendingProviderEventAgeSeconds });
    } catch {
      if (!stopped) diagnostic('refund.operations_observation_failed');
    } finally {
      observing = false;
    }
  };

  return {
    start() {
      if (started || stopped || !input.telemetry.enabled) return;
      started = true;
      void observe();
      interval = scheduler.setInterval(() => { void observe(); }, OBSERVATION_INTERVAL_MILLISECONDS);
      interval.unref?.();
    },
    stop() {
      stopped = true;
      if (interval) scheduler.clearInterval(interval);
      interval = undefined;
    },
  };
}
