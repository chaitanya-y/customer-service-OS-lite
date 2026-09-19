import type { PendingDecisionOutboxSnapshot } from './human-case-repository.js';

const OBSERVATION_INTERVAL_MILLISECONDS = 30_000;
const SAFE_FAILURE_DIAGNOSTIC = 'human-operations.decision_outbox.observation_deferred';

type DecisionOutboxSnapshotRepository = Readonly<{
  getPendingDecisionOutboxSnapshot(input: Readonly<{ tenantId: string; environmentId: string }>): Promise<PendingDecisionOutboxSnapshot>;
}>;

type OperationalGaugeRecorder = Readonly<{
  enabled: boolean;
  recordOperationalGauge(observation:
    | Readonly<{ name: 'cso.human_operations.decision_outbox.pending'; value: number }>
    | Readonly<{ name: 'cso.human_operations.decision_outbox.oldest_age'; value: number }>,
  ): void;
}>;

type IntervalHandle = Readonly<{ unref?: () => void }>;

export type DecisionOutboxObserverScheduler = Readonly<{
  setInterval(callback: () => void, delayMilliseconds: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}>;

export type DecisionOutboxObserver = Readonly<{ stop(): void }>;

export function startDecisionOutboxObserver(options: Readonly<{
  repository: DecisionOutboxSnapshotRepository;
  telemetry: OperationalGaugeRecorder;
  tenantId: string;
  environmentId: string;
  diagnostic?: (message: string) => void;
  scheduler?: DecisionOutboxObserverScheduler;
}>): DecisionOutboxObserver {
  if (!options.telemetry.enabled) return { stop() {} };

  const scheduler = options.scheduler ?? nativeScheduler;
  const diagnostic = options.diagnostic ?? ((message: string) => console.warn(message));
  let observing = false;
  let stopped = false;
  const observe = async () => {
    if (observing || stopped) return;
    observing = true;
    try {
      const snapshot = await options.repository.getPendingDecisionOutboxSnapshot({
        tenantId: options.tenantId,
        environmentId: options.environmentId,
      });
      if (stopped) return;
      options.telemetry.recordOperationalGauge({
        name: 'cso.human_operations.decision_outbox.pending',
        value: snapshot.pendingCount,
      });
      options.telemetry.recordOperationalGauge({
        name: 'cso.human_operations.decision_outbox.oldest_age',
        value: snapshot.oldestPendingAgeSeconds,
      });
    } catch {
      diagnostic(SAFE_FAILURE_DIAGNOSTIC);
    } finally {
      observing = false;
    }
  };

  void observe();
  const interval = scheduler.setInterval(() => { void observe(); }, OBSERVATION_INTERVAL_MILLISECONDS);
  interval.unref?.();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      scheduler.clearInterval(interval);
    },
  };
}

const nativeScheduler: DecisionOutboxObserverScheduler = {
  setInterval(callback, delayMilliseconds) {
    return setInterval(callback, delayMilliseconds);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};
