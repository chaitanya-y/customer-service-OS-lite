import type { WorkflowClient } from '@temporalio/client';

import type { PendingProviderRefundEvent } from './refund-execution-repository.js';

export type SignalProviderRefundOutcome = (
  event: PendingProviderRefundEvent,
) => Promise<void>;

export function createTemporalProviderRefundOutcomeSignaler(
  client: WorkflowClient,
): SignalProviderRefundOutcome {
  return async (event) => {
    const handle = client.getHandle(event.workflowId);
    await handle.signal('refund.provider-outcome', {
      eventId: event.eventId,
      providerRefundId: event.providerRefundId,
      outcome: event.outcome,
      occurredAt: event.occurredAt,
    });
  };
}
