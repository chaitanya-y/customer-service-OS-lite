"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { evidenceRejectionMessage, evidenceRequestError, evidenceStatusMessage, validateEvidenceFile, type RefundEvidence, type EvidenceAttachment } from "@cso/ui/refund-evidence-model";
import styles from "./customer-widget.module.css";

function Photo({ attachment, workflowId }: { attachment: EvidenceAttachment; workflowId: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  return <li className={styles.evidencePhoto}>
    <strong>{attachment.displayLabel}</strong>
    {attachment.technicalStatus === "READY" ? failed ? <div><p>We could not load this photo.</p><button className={styles.secondaryButton} onClick={() => { setFailed(false); setAttempt(value => value + 1); }} type="button">Retry photo</button></div> :
      <Image alt={`${attachment.displayLabel}, submitted for specialist review`} className={styles.evidenceImage} height={attachment.height!} width={attachment.width!} unoptimized
        onError={() => setFailed(true)} src={`/api/refunds/${encodeURIComponent(workflowId)}/evidence/${encodeURIComponent(attachment.evidenceId)}/content?retry=${attempt}`} /> : null}
    <p>{attachment.technicalStatus === "PROCESSING" ? "Checking file…" : attachment.technicalStatus === "REJECTED" ? evidenceRejectionMessage(attachment.rejectionCode) : "File checked. Specialist review is separate."}</p>
  </li>;
}

export function RefundEvidencePanel({ evidence, onRefresh, workflowId }: { evidence: RefundEvidence; onRefresh: () => Promise<void>; workflowId: string }) {
  const [selected, setSelected] = useState<File>();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<{ file: File; key: string; version: number } | undefined>(undefined);

  useEffect(() => {
    if (!selected) { setPreview(undefined); return; }
    const url = URL.createObjectURL(selected);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);

  function choose(file?: File) {
    pending.current = undefined;
    setNotice(undefined);
    const validation = file ? validateEvidenceFile(file) : undefined;
    setError(validation);
    setSelected(validation ? undefined : file);
    if (validation && input.current) input.current.value = "";
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !evidence.canUpload || uploading) return;
    const validation = validateEvidenceFile(selected);
    if (validation) { setError(validation); return; }
    // Keep the original key and revision for uncertain retries, even if live updates arrive.
    const attempt = pending.current?.file === selected ? pending.current : { file: selected, key: crypto.randomUUID(), version: evidence.evidenceVersion };
    pending.current = attempt;
    setUploading(true); setError(undefined); setNotice(undefined);
    try {
      const response = await fetch(`/api/refunds/${encodeURIComponent(workflowId)}/evidence`, {
        method: "POST", body: selected, headers: { "content-type": selected.type, "idempotency-key": attempt.key, "x-cso-expected-evidence-version": String(attempt.version) },
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok) {
        if (response.status === 409) { pending.current = undefined; await onRefresh(); }
        setError(evidenceRequestError(response.status, data?.error?.code));
        return;
      }
      pending.current = undefined; setSelected(undefined);
      if (input.current) input.current.value = "";
      setNotice("Photo received. File checks and specialist review may still be pending.");
      await onRefresh();
    } catch { setError("The upload result could not be confirmed. Retry this photo to check the same upload."); }
    finally { setUploading(false); }
  }

  if (evidence.requirement !== "DAMAGE_PHOTO") return null;
  return <section className={styles.evidencePanel} aria-labelledby="refund-photos-heading">
    <h2 id="refund-photos-heading">Damage photos</h2>
    <p>{evidenceStatusMessage(evidence)}</p>
    {evidence.attachments.length ? <ul className={styles.evidenceGrid}>{evidence.attachments.map(attachment => <Photo attachment={attachment} key={attachment.evidenceId} workflowId={workflowId} />)}</ul> : null}
    {evidence.canUpload ? <form className={styles.evidenceForm} onSubmit={upload} aria-busy={uploading}>
      <label htmlFor="damage-photo">Choose a damage photo</label>
      <p id="damage-photo-help">JPEG or PNG, up to 10 MB each. Up to 5 photos. Include the damaged item and avoid personal or payment details. Photos are shared only for this request’s review.</p>
      <input accept="image/jpeg,image/png" aria-describedby="damage-photo-help" disabled={uploading} id="damage-photo" onChange={event => choose(event.target.files?.[0])} ref={input} type="file" />
      {preview ? <div className={styles.evidencePhoto}><Image alt="Selected photo, not uploaded yet" className={styles.evidenceImage} height={300} src={preview} unoptimized width={400} /><button className={styles.secondaryButton} disabled={uploading} onClick={() => { choose(); if (input.current) input.current.value = ""; }} type="button">Remove selected photo</button></div> : null}
      <button className="cso-primary-button" disabled={!selected || uploading} type="submit">{uploading ? "Uploading photo…" : "Upload photo"}</button>
    </form> : evidence.assessment !== "ACCEPTED" ? <p>Photo uploads are not available in the current request state.</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
