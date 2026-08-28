"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  actionLabel,
  formatDate,
  formatMoney,
  normalizeAuditEvents,
  normalizeHumanCase,
  type AuditEvent,
  type HumanCase,
  type HumanCaseAction,
} from "./human-case";
import { getConsoleData, postConsoleData } from "./operations-api";
import styles from "./operations-console.module.css";

function ReviewPacket({ refundCase }: Readonly<{ refundCase: HumanCase }>) {
  const packet = refundCase.reviewPacket;
  return (
    <section className={styles.reviewPanel} aria-labelledby="review-packet-heading">
      <span className="cso-eyebrow">Review packet</span>
      <h2 id="review-packet-heading">Evidence before action</h2>
      <dl className={styles.definitionList}>
        <div><dt>Order</dt><dd>{packet.orderReference ?? "Not available"}</dd></div>
        <div><dt>Requested amount</dt><dd>{packet.requestedAmount ? formatMoney(packet.requestedAmount) : "Not available"}</dd></div>
        <div><dt>Refund reason</dt><dd>{packet.refundReason ?? "Not available"}</dd></div>
        <div><dt>Selected items</dt><dd>{packet.selectedItemIds.length ? packet.selectedItemIds.join(", ") : "Not specified"}</dd></div>
        <div><dt>Policy version</dt><dd>{packet.policyVersion ?? refundCase.policyVersion ?? "Not available"}</dd></div>
        <div><dt>Knowledge release</dt><dd>{packet.knowledgeReleaseId ?? "Not used"}</dd></div>
      </dl>
      <div className={styles.reasonCodes}>
        <h3>Policy reason codes</h3>
        {packet.policyReasonCodes.length ? <ul>{packet.policyReasonCodes.map((code) => <li key={code}>{code}</li>)}</ul> : <p>None were supplied.</p>}
      </div>
      <div className={styles.reasonCodes}>
        <h3>Evidence IDs</h3>
        {packet.evidenceIds.length ? <ul>{packet.evidenceIds.map((id) => <li key={id}>{id}</li>)}</ul> : <p>No evidence references were supplied.</p>}
      </div>
    </section>
  );
}

function AuditTrail({ events }: Readonly<{ events: AuditEvent[] }>) {
  return (
    <section className={styles.auditPanel} aria-labelledby="audit-heading">
      <h2 id="audit-heading">Audit trail</h2>
      {events.length ? <ol>{events.map((event, index) => <li key={`${event.createdAt ?? "event"}-${index}`}><strong>{event.eventType ?? "Case event"}</strong><span>{event.actorId ? `by ${event.actorId}` : "System event"}{event.createdAt ? ` · ${formatDate(event.createdAt)}` : ""}</span>{event.note ? <p>{event.note}</p> : null}</li>)}</ol> : <p>No audit events are available yet.</p>}
    </section>
  );
}

function DecisionForm({ onComplete, refundCase }: Readonly<{ onComplete: () => Promise<void>; refundCase: HumanCase }>) {
  const [selectedAction, setSelectedAction] = useState<HumanCaseAction | undefined>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const actionRequiresNote = selectedAction === "REJECT" || selectedAction === "RESOLVE_TAKEOVER" || selectedAction === "APPROVE_EXCEPTIONAL_REFUND";
  const canMakeDecision = refundCase.allowedActions.length > 0;
  const notePlaceholder = selectedAction === "APPROVE_EXCEPTIONAL_REFUND"
    ? "Explain why the trusted evidence supports this exceptional refund plan."
    : actionRequiresNote
      ? "Explain the rejection or manual resolution."
      : "Optional rationale for the audit trail.";

  async function claimCase() {
    setSubmitting(true); setError(undefined);
    try {
      await postConsoleData(`/api/refund-cases/${encodeURIComponent(refundCase.caseId)}/claim`, { expected_case_version: refundCase.caseVersion });
      await onComplete();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to claim this case.");
    } finally { setSubmitting(false); }
  }

  async function submitDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAction) { setError("Choose a permitted decision."); return; }
    if (actionRequiresNote && !note.trim()) { setError("A decision note is required for this action."); return; }
    setSubmitting(true); setError(undefined);
    try {
      await postConsoleData(`/api/refund-cases/${encodeURIComponent(refundCase.caseId)}/decision`, {
        decision: selectedAction,
        reason_code: decisionReasonCode(selectedAction),
        ...(note.trim() ? { note: note.trim() } : {}),
        expected_case_version: refundCase.caseVersion,
      });
      await onComplete();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The decision could not be recorded.");
    } finally { setSubmitting(false); }
  }

  return (
    <aside className={styles.decisionPanel} aria-labelledby="decision-heading">
      <span className="cso-eyebrow">Governed action</span>
      <h2 id="decision-heading">{canMakeDecision ? "Make a decision" : refundCase.canClaim ? "Claim this case" : "Case status"}</h2>
      <p>{canMakeDecision ? "This action is recorded with your staff identity and sent once to the refund workflow." : refundCase.canClaim ? "Claim the case before a decision action becomes available." : "No action is available for this case in its current state."}</p>
      <dl className={styles.caseSummary}>
        <div><dt>Case status</dt><dd>{refundCase.status.replaceAll("_", " ")}</dd></div>
        <div><dt>Assigned to</dt><dd>{refundCase.assignedStaffId ?? "Unassigned"}</dd></div>
        <div><dt>Case version</dt><dd>{refundCase.caseVersion}</dd></div>
      </dl>
      {refundCase.canClaim ? <button className="cso-primary-button" disabled={submitting} onClick={claimCase} type="button">{submitting ? "Claiming…" : "Claim this case"}</button> : null}
      {canMakeDecision ? (
        <form className={styles.decisionForm} onSubmit={submitDecision}>
          <fieldset disabled={submitting}>
            <legend>Permitted actions</legend>
            {refundCase.allowedActions.map((action) => <label className={styles.actionOption} key={action}><input checked={selectedAction === action} name="decision" onChange={() => setSelectedAction(action)} type="radio" value={action} />{actionLabel(action)}</label>)}
          </fieldset>
          <label htmlFor="decision-note">Decision note{actionRequiresNote ? " (required)" : " (optional)"}</label>
          <textarea id="decision-note" maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder={notePlaceholder} rows={5} value={note} />
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <button className="cso-primary-button" disabled={submitting || !selectedAction} type="submit">{submitting ? "Recording decision…" : "Record decision"}</button>
        </form>
      ) : null}
    </aside>
  );
}

function decisionReasonCode(action: HumanCaseAction): string {
  if (action === "APPROVE") return "HUMAN_APPROVED";
  if (action === "APPROVE_EXCEPTIONAL_REFUND") return "EXCEPTIONAL_REFUND_PLAN_APPROVED";
  if (action === "REJECT") return "HUMAN_REJECTED";
  return "MANUAL_TAKEOVER_RESOLVED";
}

export function RefundCaseDetail({ caseId }: Readonly<{ caseId: string }>) {
  const [refundCase, setRefundCase] = useState<HumanCase | undefined>();
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [refreshToken, setRefreshToken] = useState(0);

  const loadCase = useCallback(async () => {
    setError(undefined);
    try {
      const data = await getConsoleData(`/api/refund-cases/${encodeURIComponent(caseId)}`);
      const record = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
      const nextCase = normalizeHumanCase(record.refund_case);
      if (!nextCase) throw new Error("Human Operations returned an invalid case.");
      setRefundCase(nextCase);
      setAuditEvents(normalizeAuditEvents(data));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load this case.");
    }
  }, [caseId]);

  useEffect(() => { void loadCase(); }, [loadCase, refreshToken]);
  const refresh = useMemo(() => async () => setRefreshToken((value) => value + 1), []);

  return (
    <section className={styles.detail}>
      <Link className={styles.backLink} href="/refund-cases">← Refund cases</Link>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {!refundCase && !error ? <p className={styles.loading}>Loading case review…</p> : null}
      {refundCase ? <>
        <header className={styles.detailHeader}>
          <div><span className="cso-eyebrow">{refundCase.caseType === "REFUND_APPROVAL" ? "Refund approval" : "Manual refund takeover"}</span><h1>{refundCase.reviewPacket.orderReference ?? "Refund case"}</h1><p>Workflow {refundCase.workflowId}</p></div>
          <span className={`${styles.status} ${styles[`status${refundCase.status}`]}`}>{refundCase.status.replaceAll("_", " ")}</span>
        </header>
        <div className={styles.detailGrid}><ReviewPacket refundCase={refundCase} /><DecisionForm onComplete={refresh} refundCase={refundCase} /></div>
        <AuditTrail events={auditEvents} />
      </> : null}
    </section>
  );
}
