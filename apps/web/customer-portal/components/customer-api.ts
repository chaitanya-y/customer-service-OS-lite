export type RefundAmount = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type CustomerCitation = Readonly<{
  documentTitle: string;
  excerpt?: string;
  effectiveAt?: string;
}>;

export type JourneyTimelineEvent = Readonly<{
  eventId: string;
  occurredAt: string;
  label: string;
  detail?: string;
}>;

export type RefundJourney = Readonly<{
  workflowId: string;
  stage: string;
  statusLabel: string;
  statusDetail: string;
  preview?: Readonly<{
    previewId: string;
    amount: RefundAmount;
    reasonLabel?: string;
    orderReference?: string;
    expiresAt?: string;
  }>;
  nextAction: "CONFIRM_OR_DECLINE" | "WAIT" | "NONE";
  citations: readonly CustomerCitation[];
  timeline: readonly JourneyTimelineEvent[];
  updatedAt?: string;
}>;

type UnknownRecord = Record<string, unknown>;

const statusCopy: Record<string, Readonly<{ label: string; detail: string }>> = {
  EVALUATING: { label: "Reviewing your request", detail: "We are checking the details of your request." },
  AWAITING_CUSTOMER_CONFIRMATION: { label: "Refund ready for confirmation", detail: "Review the exact amount before we submit the refund." },
  AWAITING_APPROVAL: { label: "Under review", detail: "A specialist is reviewing your request." },
  HUMAN_TAKEOVER_REQUIRED: { label: "A specialist is helping", detail: "Your request needs personal support." },
  PENDING_RECONCILIATION: { label: "We are confirming the refund", detail: "We received your request and are confirming its final status." },
  REFUND_SUCCEEDED: { label: "Refund submitted", detail: "Your refund has been submitted. Your payment provider may take time to display it." },
  REFUND_FAILED: { label: "Refund needs attention", detail: "We could not complete the refund automatically. A specialist can help." },
  PREVIEW_INVALIDATED: { label: "Refund details changed", detail: "Your refund details changed. Please start a new request so we can review the latest amount." },
  DENIED: { label: "Refund request could not be approved", detail: "We could not approve this refund request based on the information available." },
  NEEDS_FACTS: { label: "More information is needed", detail: "We need more information before we can review this request." },
  CANCELLED: { label: "Refund request closed", detail: "You declined this refund preview. You can start another request if you need help." },
  REJECTED: { label: "Refund request closed", detail: "A specialist could not approve this refund request." },
  TAKEOVER_RESOLVED: { label: "Support review completed", detail: "A specialist has completed their review of your request." },
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asAmount(value: unknown): RefundAmount | undefined {
  if (!isRecord(value) || typeof value.amountMinor !== "number" || !Number.isFinite(value.amountMinor)) return undefined;
  const currency = asText(value.currency);
  return currency ? { amountMinor: value.amountMinor, currency } : undefined;
}

function normalizeCitations(value: unknown): CustomerCitation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((citation) => {
    if (!isRecord(citation)) return [];
    const classification = asText(citation.classification)?.toUpperCase();
    if (classification === "INTERNAL" || classification === "INTERNAL_ONLY") return [];
    const documentTitle = asText(citation.documentTitle) ?? asText(citation.document_title);
    if (!documentTitle) return [];
    const excerpt = asText(citation.excerpt);
    const effectiveAt = asText(citation.effectiveAt) ?? asText(citation.effective_at);
    return [{ documentTitle, ...(excerpt ? { excerpt } : {}), ...(effectiveAt ? { effectiveAt } : {}) }];
  });
}

function normalizeTimeline(value: unknown): JourneyTimelineEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event, index) => {
    if (!isRecord(event)) return [];
    const label = asText(event.label);
    const eventId = asText(event.eventId) ?? asText(event.event_id) ?? String(index);
    const occurredAt = asText(event.occurredAt) ?? asText(event.occurred_at);
    if (!label || !occurredAt) return [];
    const detail = asText(event.detail);
    return [{ eventId, occurredAt, label, ...(detail ? { detail } : {}) }];
  });
}

export function getApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const error = isRecord(payload.error) ? payload.error : payload;
  return asText(error.message) ?? fallback;
}

export function normalizeRefundJourney(workflowId: string, payload: unknown): RefundJourney {
  if (!isRecord(payload)) throw new Error("The refund status response was not valid.");
  const status = isRecord(payload.status) ? payload.status : undefined;
  const stage = asText(status?.code) ?? asText(payload.stage) ?? "EVALUATING";
  const copy = statusCopy[stage] ?? statusCopy.EVALUATING;
  const previewValue = isRecord(payload.preview) ? payload.preview : undefined;
  const amount = asAmount(previewValue?.amount) ?? asAmount(previewValue?.requestedAmount);
  const previewId = asText(previewValue?.previewId) ?? asText(previewValue?.preview_id);
  const preview = previewId && amount ? {
    previewId,
    amount,
    reasonLabel: asText(previewValue?.reasonLabel) ?? asText(previewValue?.reason_label),
    orderReference: asText(previewValue?.orderReference) ?? asText(previewValue?.order_reference),
    expiresAt: asText(previewValue?.expiresAt) ?? asText(previewValue?.validUntil),
  } : undefined;
  const requestedNextAction = asText(payload.nextAction) ?? asText(payload.next_action);
  const nextAction = requestedNextAction === "CONFIRM_OR_DECLINE" || requestedNextAction === "WAIT" || requestedNextAction === "NONE"
    ? requestedNextAction
    : stage === "AWAITING_CUSTOMER_CONFIRMATION" && preview
      ? "CONFIRM_OR_DECLINE"
      : stage === "EVALUATING" ? "WAIT" : "NONE";

  return {
    workflowId: asText(payload.journeyId) ?? asText(payload.workflow_id) ?? workflowId,
    stage,
    statusLabel: asText(status?.label) ?? copy.label,
    statusDetail: asText(status?.detail) ?? copy.detail,
    ...(preview ? { preview } : {}),
    nextAction,
    citations: normalizeCitations(payload.citations),
    timeline: normalizeTimeline(payload.timeline),
    updatedAt: asText(payload.updatedAt) ?? asText(payload.updated_at),
  };
}

export function formatRefundAmount(amount: RefundAmount): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency }).format(amount.amountMinor / 100);
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
