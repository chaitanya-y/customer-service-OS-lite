"use client";

import { useCallback, useEffect, useState } from "react";

import {
  formatDateTime,
  formatRefundAmount,
  getApiErrorMessage,
  normalizeRefundJourney,
  type RefundJourney,
} from "./customer-api";
import styles from "./customer-widget.module.css";

export function RefundJourney({ workflowId }: { workflowId: string }) {
  const [journey, setJourney] = useState<RefundJourney>();
  const [errorMessage, setErrorMessage] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isConfirming, setIsConfirming] = useState(false);

  const loadJourney = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(undefined);

    try {
      const response = await fetch(`/api/refunds/${encodeURIComponent(workflowId)}`, {
        cache: "no-store",
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new Error(getApiErrorMessage(body, "We could not load your refund status."));
      }
      setJourney(normalizeRefundJourney(workflowId, body));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "We could not load your refund status.");
    } finally {
      setIsLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    void loadJourney();
  }, [loadJourney]);

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
    : [{ eventId: "current", occurredAt: journey.updatedAt ?? "", label: journey.statusLabel, detail: journey.statusDetail }];

  return (
    <div className={styles.journeyLayout} aria-live="polite">
      <section className={styles.journeyPanel} aria-labelledby="refund-status-heading">
        <span className="cso-eyebrow">Refund request</span>
        <h1 id="refund-status-heading">{journey.statusLabel}</h1>
        <p className={styles.journeyDetail}>{journey.statusDetail}</p>

        {journey.preview ? (
          <div className={styles.preview}>
            <p className={styles.previewLabel}>Refund amount</p>
            <p className={styles.previewAmount}>{formatRefundAmount(journey.preview.amount)}</p>
            {journey.preview.reasonLabel ? <p className={styles.previewReason}>{journey.preview.reasonLabel}</p> : null}
            {journey.preview.orderReference ? <p className={styles.previewLabel}>Order {journey.preview.orderReference}</p> : null}
            {journey.preview.expiresAt ? <p className={styles.previewLabel}>Review by {formatDateTime(journey.preview.expiresAt)}</p> : null}
            {journey.nextAction === "CONFIRM_OR_DECLINE" ? (
              <div className={styles.actions}>
                <button className={styles.secondaryButton} disabled={isConfirming} onClick={() => void submitConfirmation(false)} type="button">Decline</button>
                <button className="cso-primary-button" disabled={isConfirming} onClick={() => void submitConfirmation(true)} type="button">{isConfirming ? "Submitting…" : "Confirm refund"}</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}

        {journey.citations.length > 0 ? (
          <section className={styles.citations} aria-labelledby="policy-sources-heading">
            <h2 id="policy-sources-heading">Based on</h2>
            {journey.citations.map((citation) => (
              <article className={styles.citation} key={`${citation.documentTitle}-${citation.effectiveAt ?? ""}`}>
                <strong>{citation.documentTitle}</strong>
                {citation.effectiveAt ? <span>Effective {formatDateTime(citation.effectiveAt)}</span> : null}
                {citation.excerpt ? <p>{citation.excerpt}</p> : null}
              </article>
            ))}
          </section>
        ) : null}
      </section>

      <aside className={styles.timelinePanel} aria-labelledby="progress-heading">
        <h2 id="progress-heading">Progress</h2>
        <ol className={styles.timeline}>
          {timeline.map((event) => (
            <li key={event.eventId}>
              <strong>{event.label}</strong>
              {event.occurredAt ? <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt)}</time> : null}
              {event.detail ? <span>{event.detail}</span> : null}
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
