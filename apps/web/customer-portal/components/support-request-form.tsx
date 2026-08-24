"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { getApiErrorMessage } from "./customer-api";
import styles from "./customer-widget.module.css";

const MESSAGE_LIMIT = 2_000;
const ORDER_REFERENCE_LIMIT = 100;

type IntakeResponse = Readonly<{
  refund_workflow?: Readonly<{ workflow_id?: unknown }>;
  workflow_id?: unknown;
  missing_fields?: unknown;
}>;

function readWorkflowId(response: IntakeResponse): string | undefined {
  const candidate = response.refund_workflow?.workflow_id ?? response.workflow_id;
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function readMissingFields(response: IntakeResponse): string[] {
  return Array.isArray(response.missing_fields)
    ? response.missing_fields.filter((field): field is string => typeof field === "string")
    : [];
}

export function SupportRequestForm() {
  const router = useRouter();
  const [customerMessage, setCustomerMessage] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [clarification, setClarification] = useState<string[] | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const idempotencyKey = useRef<string | undefined>(undefined);

  function resetSubmitState() {
    idempotencyKey.current = undefined;
    setErrorMessage(undefined);
    setClarification(undefined);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = customerMessage.trim();
    const reference = orderReference.trim();
    if (!message) {
      setErrorMessage("Describe what happened before continuing.");
      return;
    }

    setErrorMessage(undefined);
    setClarification(undefined);
    setIsSubmitting(true);
    idempotencyKey.current ??= crypto.randomUUID();

    try {
      const response = await fetch("/api/refunds/intake", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey.current },
        body: JSON.stringify({ customer_message: message, ...(reference ? { order_reference: reference } : {}) }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(getApiErrorMessage(body, "We cannot review this request right now. Please try again."));

      const workflowId = readWorkflowId((body ?? {}) as IntakeResponse);
      if (workflowId) {
        router.push(`/refunds/${encodeURIComponent(workflowId)}`);
        return;
      }

      setClarification(readMissingFields((body ?? {}) as IntakeResponse));
      idempotencyKey.current = undefined;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "We cannot review this request right now. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <div className={styles.fieldGroup}>
        <label htmlFor="customer-message">What happened?</label>
        <textarea aria-describedby="customer-message-hint" disabled={isSubmitting} id="customer-message" maxLength={MESSAGE_LIMIT} onChange={(event) => { setCustomerMessage(event.target.value); resetSubmitState(); }} placeholder="My order arrived damaged. I need a refund." required rows={6} value={customerMessage} />
        <div className={styles.fieldHint} id="customer-message-hint">{customerMessage.length}/{MESSAGE_LIMIT}</div>
      </div>
      <div className={styles.fieldGroup}>
        <label htmlFor="order-reference">Order reference <span>(optional)</span></label>
        <input disabled={isSubmitting} id="order-reference" maxLength={ORDER_REFERENCE_LIMIT} onChange={(event) => { setOrderReference(event.target.value); resetSubmitState(); }} placeholder="For example, QXB4NEW2EPG6YJ7Q" type="text" value={orderReference} />
      </div>
      {errorMessage ? <p className={styles.error} role="alert">{errorMessage}</p> : null}
      {clarification ? <div className={styles.notice} role="status"><strong>We need a little more information.</strong>{clarification.length > 0 ? <p>Please include: {clarification.join(", ")}.</p> : <p>Please add more detail and try again.</p>}</div> : null}
      <button className="cso-primary-button" disabled={isSubmitting} type="submit">{isSubmitting ? "Reviewing request…" : "Continue"}</button>
    </form>
  );
}
