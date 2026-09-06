"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { evidenceRejectionMessage, evidenceRequestError, evidenceStatusMessage, type EvidenceAttachment } from "@cso/ui/refund-evidence-model";
import { buildEvidenceReviewCommand, type EvidenceReviewAction, type EvidenceReviewReason, type HumanCase } from "./human-case";
import { OperationsApiError, postConsoleData } from "./operations-api";
import styles from "./operations-console.module.css";

function EvidencePhoto({ attachment, caseId, onAvailability }: { attachment: EvidenceAttachment; caseId: string; onAvailability: (id: string, available: boolean) => void }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <li className={styles.evidencePhoto}>
    <strong>{attachment.displayLabel}</strong>
    {attachment.technicalStatus === "READY" ? failed ? <div><p>This photo could not be loaded. Do not assess photos you cannot view.</p><button className={styles.filter} onClick={() => { setFailed(false); setAttempt(value => value + 1); }} type="button">Retry photo</button></div> :
      <Image alt={`${attachment.displayLabel}, customer-submitted damage evidence`} className={styles.evidenceImage} height={attachment.height!} width={attachment.width!} unoptimized
        onLoad={() => onAvailability(attachment.evidenceId, true)} onError={() => { setFailed(true); onAvailability(attachment.evidenceId, false); }} src={`/api/refund-cases/${encodeURIComponent(caseId)}/evidence/${encodeURIComponent(attachment.evidenceId)}/content?retry=${attempt}`} /> : null}
    <p>{attachment.technicalStatus === "PROCESSING" ? "File validation in progress. Review is unavailable until checks finish." : attachment.technicalStatus === "REJECTED" ? evidenceRejectionMessage(attachment.rejectionCode) : "File validation passed. Specialist assessment is still a separate decision."}</p>
  </li>;
}

export function RefundEvidenceReview({ refundCase, onRefresh }: { refundCase: HumanCase; onRefresh: () => Promise<void> }) {
  const [action, setAction] = useState<EvidenceReviewAction>();
  const [reason, setReason] = useState<EvidenceReviewReason>();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [availablePhotos, setAvailablePhotos] = useState<Record<string, boolean>>({});
  const pending = useRef<{ command: ReturnType<typeof buildEvidenceReviewCommand>; key: string } | undefined>(undefined);
  const evidence = refundCase.evidence;
  const actions = refundCase.allowedEvidenceActions;
  const photosAvailable = Boolean(evidence?.attachments.some(photo => photo.technicalStatus === "READY")) &&
    Boolean(evidence?.attachments.filter(photo => photo.technicalStatus === "READY").every(photo => availablePhotos[photo.evidenceId]));

  useEffect(() => {
    setAction(undefined); setReason(undefined);
    // Preserve an uncertain command for explicit retry; never silently rebind it to a newer revision.
  }, [refundCase.caseVersion, evidence?.evidenceVersion]);

  function choose(nextAction: EvidenceReviewAction) {
    pending.current = undefined; setError(undefined); setNotice(undefined);
    setAction(nextAction); setReason(nextAction === "ACCEPT_EVIDENCE" ? "DAMAGE_VISIBLE" : undefined);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !action || !reason || !photosAvailable) return;
    setSubmitting(true); setError(undefined); setNotice(undefined);
    try {
      const command = buildEvidenceReviewCommand(refundCase, action, reason, note);
      const attempt = pending.current && JSON.stringify(pending.current.command) === JSON.stringify(command)
        ? pending.current : { command, key: crypto.randomUUID() };
      pending.current = attempt;
      await postConsoleData(`/api/refund-cases/${encodeURIComponent(refundCase.caseId)}/evidence-review`, attempt.command, attempt.key);
      pending.current = undefined; setAction(undefined); setReason(undefined); setNote("");
      setNotice("Evidence review recorded. The workflow will refresh its policy checks; no refund has been approved by this action.");
      await onRefresh();
    } catch (requestError) {
      if (requestError instanceof OperationsApiError) {
        setError(evidenceRequestError(requestError.status, requestError.code));
        if (requestError.status === 409) { pending.current = undefined; setAction(undefined); setReason(undefined); await onRefresh(); }
      } else { setError(requestError instanceof Error ? requestError.message : "The review result could not be confirmed. Retry the same review."); }
    } finally { setSubmitting(false); }
  }

  if (!evidence && refundCase.caseType !== "REFUND_EVIDENCE_REVIEW") return null;
  return <section className={styles.reviewPanel} aria-labelledby="damage-evidence-heading">
    <span className="cso-eyebrow">Customer photos</span>
    <h2 id="damage-evidence-heading">Damage evidence review</h2>
    <p className={styles.muted}>Assess whether these photos show damage to the item from this order. File validation is not evidence acceptance, and evidence acceptance is not refund approval.</p>
    {!evidence ? <p role="status">Photo details are unavailable. Refresh the case before reviewing evidence.</p> : <>
      <p>{evidenceStatusMessage(evidence)}</p>
      <p className={styles.muted}>Evidence revision {evidence.evidenceVersion}</p>
      {evidence.attachments.length ? <ul className={styles.evidenceGrid}>{evidence.attachments.map(attachment => <EvidencePhoto attachment={attachment} caseId={refundCase.caseId} key={attachment.evidenceId} onAvailability={(id, available) => setAvailablePhotos(previous => previous[id] === available ? previous : { ...previous, [id]: available })} />)}</ul> : <p>No photos have been received yet.</p>}
    </>}
    {actions.length ? <form className={styles.decisionForm} onSubmit={submit} aria-busy={submitting}>
      <fieldset disabled={submitting}><legend>Evidence assessment</legend>
        {actions.map(option => <label className={styles.actionOption} key={option}><input checked={action === option} name="evidence-action" onChange={() => choose(option)} type="radio" />{option === "ACCEPT_EVIDENCE" ? "Accept damage evidence" : "Request another photo"}</label>)}
      </fieldset>
      {action === "ACCEPT_EVIDENCE" ? <p>Record only if damage is visible and the item can be identified. This does not authorize money movement.</p> : null}
      {action === "REQUEST_MORE_EVIDENCE" ? <><label htmlFor="evidence-reason">What should the customer improve?</label><select disabled={submitting} id="evidence-reason" onChange={event => { setReason(event.target.value as EvidenceReviewReason || undefined); pending.current = undefined; }} required value={reason ?? ""}><option value="">Choose a reason</option><option value="PHOTO_UNCLEAR">Photo is unclear</option><option value="DAMAGED_ITEM_NOT_VISIBLE">Damaged item is not visible</option><option value="ORDER_ITEM_NOT_IDENTIFIABLE">Order item cannot be identified</option></select></> : null}
      <label htmlFor="evidence-note">Internal review note (optional)</label>
      <textarea aria-describedby="evidence-note-help" disabled={submitting} id="evidence-note" maxLength={2000} onChange={event => { setNote(event.target.value); pending.current = undefined; }} rows={3} value={note} />
      <p id="evidence-note-help" className={styles.muted}>Only the selected customer guidance is shared. This note stays in the staff audit trail.</p>
      {!photosAvailable ? <p role="status">Load all available photos before recording an evidence review. A loading error is not a reason to reject a customer’s evidence.</p> : null}
      <button className="cso-primary-button" disabled={submitting || !action || !reason || !photosAvailable} type="submit">{submitting ? "Recording review…" : "Record evidence review"}</button>
    </form> : <p className={styles.muted}>{refundCase.canClaim ? "Claim this case to review the evidence once file checks finish." : evidence?.assessment === "ACCEPTED" ? "The workflow is responsible for the next policy and refund steps." : "Review controls require an eligible staff role, this case’s claim, and photos that have finished file checks."}</p>}
    <button className={styles.filter} disabled={submitting} onClick={() => void onRefresh()} type="button">Refresh evidence</button>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
