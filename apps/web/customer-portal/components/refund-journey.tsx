"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  formatDateTime,
  formatRefundAmount,
  formatRefundDestination,
  getApiErrorMessage,
  getRefundReviewDeadline,
  normalizeRefundJourney,
  type RefundJourney,
} from "./customer-api";
import styles from "./customer-widget.module.css";
import { RefundEvidencePanel } from "./refund-evidence";
import {
  useRefundJourneyUpdates,
  type RefundJourneyUpdateConnection,
} from "./use-refund-journey-updates";

function updateConnectionLabel(connection: RefundJourneyUpdateConnection): string {
  switch (connection) {
    case "live":
      return "Live updates active";
    case "polling":
      return "Checking for updates every 10 seconds";
    case "reconnecting":
      return "Reconnecting to live updates. We are checking every 10 seconds.";
    case "connecting":
      return "Connecting to live updates…";
  }
}

function timelineStatusLabel(status: "COMPLETED" | "CURRENT" | "PENDING" | "SKIPPED"): string {
  if (status === "CURRENT") return "Current step";
  if (status === "COMPLETED") return "Completed";
  if (status === "SKIPPED") return "Not required";
  return "Upcoming";
}

export function RefundJourney({ workflowId }: { workflowId: string }) {
  const [journey, setJourney] = useState<RefundJourney>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);
  const journeyRefreshInFlight = useRef(false);

  const loadJourney = useCallback(async (background = false) => {
    if (journeyRefreshInFlight.current) return;
    journeyRefreshInFlight.current = true;

    if (!background) {
      setIsLoading(true);
      setErrorMessage(undefined);
    }

    try {
      const response = await fetch(`/api/refunds/${encodeURIComponent(workflowId)}/journey`, {
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(body, "We could not load your refund status."));
      }
      setJourney(normalizeRefundJourney(workflowId, body));
    } catch (error) {
      if (!background) {
        setErrorMessage(error instanceof Error ? error.message : "We could not load your refund status.");
      }
    } finally {
      if (!background) setIsLoading(false);
      journeyRefreshInFlight.current = false;
    }
  }, [workflowId]);

  const refreshJourneyFromUpdate = useCallback(() => {
    void loadJourney(true);
  }, [loadJourney]);
  const updateConnection = useRefundJourneyUpdates(workflowId, refreshJourneyFromUpdate);

  useEffect(() => {
    void loadJourney();
  }, [loadJourney]);

  useEffect(() => {
    if (journey?.stage !== "AWAITING_CUSTOMER_EVIDENCE" && journey?.stage !== "AWAITING_EVIDENCE_REVIEW") return;
    // Supplement event updates while asynchronous file checks and staff review are pending.
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void loadJourney(true); }, 10_000);
    return () => window.clearInterval(timer);
  }, [journey?.stage, loadJourney]);

  async function submitConfirmation(accepted: boolean) {
    if (!journey?.preview || journey.nextAction !== "CONFIRM_OR_DECLINE") return;

    setIsConfirming(true);
    setErrorMessage(undefined);
    try {
      const response = await fetch(`/api/refunds/${encodeURIComponent(workflowId)}/confirmation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preview_id: journey.preview.previewId, accepted }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(body, "We could not record your decision. Please try again."));
      }
      await loadJourney();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "We could not record your decision. Please try again.");
    } finally {
      setIsConfirming(false);
    }
  }

  if (isLoading && !journey) {
    return <p className={styles.loading}>Loading your refund request…</p>;
  }

  if (!journey) {
    return (
      <section className={styles.journeyPanel} aria-live="polite">
        <h1>We could not load your refund request.</h1>
        <p className={styles.journeyDetail}>{errorMessage}</p>
        <button className="cso-primary-button" onClick={() => void loadJourney()} type="button">Try again</button>
      </section>
    );
  }

  const timeline = journey.timeline.length > 0
    ? journey.timeline
    : [{ eventId: "current", label: journey.statusLabel, status: "CURRENT" as const }];
  const reviewDeadline = getRefundReviewDeadline(journey);

  return (
    <div className={styles.journeyLayout} aria-live="polite">
      <section className={styles.journeyPanel} aria-labelledby="refund-status-heading">
        <span className="cso-eyebrow">Refund request</span>
        <h1 id="refund-status-heading">{journey.statusLabel}</h1>
        <p className={styles.journeyDetail}>{journey.statusDetail}</p>
        {journey.nextActionLabel ? <p className={styles.nextAction}>{journey.nextActionLabel}</p> : null}
        <p aria-live="polite" className={styles.updateConnection}>
          {updateConnectionLabel(updateConnection)}
        </p>

        {journey.evidence ? <RefundEvidencePanel evidence={journey.evidence} onRefresh={() => loadJourney(true)} workflowId={workflowId} /> : journey.stage === "AWAITING_CUSTOMER_EVIDENCE" || journey.stage === "AWAITING_EVIDENCE_REVIEW" ? <section className={styles.evidencePanel}><h2>Damage photos</h2><p>Photo details are temporarily unavailable.</p><button className={styles.secondaryButton} onClick={() => void loadJourney()} type="button">Refresh photo details</button></section> : null}

        {journey.preview ? (
          <div className={styles.preview}>
            <p className={styles.previewLabel}>Refund amount</p>
            <p className={styles.previewAmount}>{formatRefundAmount(journey.preview.amount)}</p>
            <p className={styles.previewReason}>Returned to {formatRefundDestination(journey.preview.refundDestination)}</p>
            {reviewDeadline ? <p className={styles.previewLabel}>Review by {formatDateTime(reviewDeadline)}</p> : null}
            {journey.nextAction === "CONFIRM_OR_DECLINE" ? (
              <div className={styles.actions}>
                <button className={styles.secondaryButton} disabled={isConfirming} onClick={() => void submitConfirmation(false)} type="button">Decline</button>
                <button className="cso-primary-button" disabled={isConfirming} onClick={() => void submitConfirmation(true)} type="button">{isConfirming ? "Submitting…" : "Confirm refund"}</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}

      </section>

      <aside className={styles.timelinePanel} aria-labelledby="progress-heading">
        <h2 id="progress-heading">Progress</h2>
        <ol className={styles.timeline}>
          {timeline.map((event) => (
            <li aria-current={event.status === "CURRENT" ? "step" : undefined} key={event.eventId}>
              <strong>{event.label}</strong>
              <span>{timelineStatusLabel(event.status)}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
