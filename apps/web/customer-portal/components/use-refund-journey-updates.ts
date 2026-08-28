"use client";

import { useEffect, useState } from "react";

const POLLING_INTERVAL_MILLISECONDS = 10_000;

export type RefundJourneyUpdateConnection =
  | "connecting"
  | "live"
  | "reconnecting"
  | "polling";

/**
 * Listens only for a change signal. The customer-safe journey endpoint stays
 * the sole source of displayed data, so event payloads cannot expose internal
 * workflow information in the browser.
 */
export function useRefundJourneyUpdates(
  workflowId: string,
  refreshJourney: () => void,
): RefundJourneyUpdateConnection {
  const [connection, setConnection] = useState<RefundJourneyUpdateConnection>("connecting");

  useEffect(() => {
    let disposed = false;
    let pollingTimer: number | undefined;

    function startPollingFallback() {
      if (pollingTimer) return;
      pollingTimer = window.setInterval(refreshJourney, POLLING_INTERVAL_MILLISECONDS);
    }

    function stopPollingFallback() {
      if (!pollingTimer) return;
      window.clearInterval(pollingTimer);
      pollingTimer = undefined;
    }

    if (!("EventSource" in window)) {
      setConnection("polling");
      startPollingFallback();
      return () => stopPollingFallback();
    }

    const events = new EventSource(
      `/api/refunds/${encodeURIComponent(workflowId)}/events`,
    );
    const refreshFromEvent = () => refreshJourney();

    events.onopen = () => {
      if (disposed) return;
      stopPollingFallback();
      setConnection("live");
    };
    events.onmessage = refreshFromEvent;
    events.addEventListener("refund_journey_updated", refreshFromEvent);
    events.addEventListener("journey.updated", refreshFromEvent);

    events.onerror = () => {
      if (disposed) return;
      setConnection("reconnecting");
      startPollingFallback();
    };

    return () => {
      disposed = true;
      stopPollingFallback();
      events.close();
    };
  }, [refreshJourney, workflowId]);

  return connection;
}
