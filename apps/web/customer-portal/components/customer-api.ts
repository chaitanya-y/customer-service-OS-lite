import { normalizeRefundEvidence, type RefundEvidence } from "@cso/ui/refund-evidence-model";

export type RefundAmount = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type JourneyTimelineEvent = Readonly<{
  eventId: string;
  label: string;
  status: "COMPLETED" | "CURRENT" | "PENDING" | "SKIPPED";
}>;

export type RefundJourney = Readonly<{
  workflowId: string;
  stage: string;
  statusLabel: string;
  statusDetail: string;
  preview?: Readonly<{
    previewId: string;
    amount: RefundAmount;
    refundDestination: string;
    expiresAt?: string;
  }>;
  evidence?: RefundEvidence;
  nextAction: "CONFIRM_OR_DECLINE" | "PROVIDE_EVIDENCE" | "WAIT" | "NONE";
  nextActionLabel: string;
  timeline: readonly JourneyTimelineEvent[];
}>;

type UnknownRecord = Record<string, unknown>;

const statusCopy: Record<string, Readonly<{ label: string; detail: string }>> = {
  REQUEST_RECEIVED: { label: "Reviewing your request", detail: "We are checking the details of your request." },
  REFUND_PREVIEW_READY: { label: "Refund ready for confirmation", detail: "Review the exact amount before we submit the refund." },
  SPECIALIST_REVIEWING: { label: "A specialist is helping", detail: "A specialist is reviewing your request." },
  AWAITING_CUSTOMER_EVIDENCE: { label: "Photos are needed", detail: "Please add photos of the damaged item so a specialist can review your request." },
  AWAITING_EVIDENCE_REVIEW: { label: "Your photos are under review", detail: "A specialist is checking the damage evidence. Uploading photos does not approve a refund." },
  EVIDENCE_COLLECTION_EXPIRED: { label: "The photo review window has ended", detail: "This request can no longer receive photos. Please contact support to start a new review of the latest details." },
  REFUND_PROCESSING: { label: "Refund initiated", detail: "Your refund was sent to your payment provider. We will update this page when its final status is confirmed." },
  REFUND_COMPLETED: { label: "Refund completed", detail: "Your refund was confirmed successfully. Your bank may still need a few business days to show it on your statement." },
  MORE_INFORMATION_NEEDED: { label: "More information is needed", detail: "We need more information before we can review this request." },
  REFUND_NOT_APPROVED: { label: "Refund request could not be approved", detail: "We could not approve this refund request based on the information available." },
  REFUND_CANCELLED: { label: "Refund request closed", detail: "You declined this refund preview. You can start another request if you need help." },
  PREVIEW_EXPIRED: { label: "Refund preview no longer available", detail: "This refund preview expired or the order details changed. Please start a new request so we can review the latest details." },
  REFUND_FAILED: { label: "Refund needs attention", detail: "We could not complete the refund automatically. A specialist can help." },
  REQUEST_RESOLVED: { label: "Support review completed", detail: "A specialist has completed their review of your request." },
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, maximumLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : undefined;
}

function asAmount(value: unknown): RefundAmount | undefined {
  if (
    !isRecord(value)
    || typeof value.amount_minor !== "number"
    || !Number.isSafeInteger(value.amount_minor)
    || value.amount_minor < 0
  ) return undefined;
  const currency = asText(value.currency, 3)?.toUpperCase();
  return currency && /^[A-Z]{3}$/.test(currency)
    ? { amountMinor: value.amount_minor, currency }
    : undefined;
}

function normalizeTimeline(value: unknown): JourneyTimelineEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((event) => {
    if (!isRecord(event)) return [];
    const label = asText(event.label);
    const eventId = asText(event.id, 100);
    const status = asText(event.status, 16);
    if (!label || !eventId || !isTimelineStatus(status)) return [];
    return [{ eventId, label, status }];
  });
}

function isTimelineStatus(value: string | undefined): value is JourneyTimelineEvent["status"] {
  return value === "COMPLETED" || value === "CURRENT" || value === "PENDING" || value === "SKIPPED";
}

function normalizeNextAction(value: unknown, hasPreview: boolean): RefundJourney["nextAction"] {
  const action = isRecord(value) ? asText(value.type, 48) : undefined;
  if (action === "CONFIRM_REFUND" && hasPreview) return "CONFIRM_OR_DECLINE";
  if (action === "PROVIDE_EVIDENCE") return "PROVIDE_EVIDENCE";
  if (action === "WAIT_FOR_SPECIALIST" || action === "WAIT_FOR_REFUND") return "WAIT";
  return "NONE";
}

export function getApiErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const error = isRecord(payload.error) ? payload.error : payload;
  return asText(error.message) ?? fallback;
}

export function normalizeRefundJourney(workflowId: string, payload: unknown): RefundJourney {
  if (!isRecord(payload)) throw new Error("The refund status response was not valid.");
  if (payload.version !== "v1") throw new Error("The refund status response was not valid.");
  const stage = asText(payload.stage, 64) ?? "REQUEST_RECEIVED";
  const copy = statusCopy[stage] ?? statusCopy.REQUEST_RECEIVED;
  const previewValue = isRecord(payload.preview) ? payload.preview : undefined;
  const amount = asAmount(previewValue?.amount);
  const previewId = asText(previewValue?.preview_id, 200);
  const refundDestination = asText(previewValue?.refund_destination);
  const preview = previewId && amount && refundDestination ? {
    previewId,
    amount,
    refundDestination,
    expiresAt: asText(previewValue?.valid_until, 100),
  } : undefined;
  const nextActionValue = isRecord(payload.next_action) ? payload.next_action : undefined;
  const nextAction = stage === "EVIDENCE_COLLECTION_EXPIRED" ? "NONE" : normalizeNextAction(nextActionValue, Boolean(preview));
  const evidenceSummary = normalizeRefundEvidence(payload.evidence);
  const evidence = evidenceSummary && stage === "EVIDENCE_COLLECTION_EXPIRED"
    ? { ...evidenceSummary, canUpload: false } : evidenceSummary;

  return {
    workflowId,
    stage,
    statusLabel: copy.label,
    statusDetail: copy.detail,
    ...(preview ? { preview } : {}),
    ...(evidence ? { evidence } : {}),
    nextAction,
    nextActionLabel: asText(nextActionValue?.label) ?? "",
    timeline: normalizeTimeline(payload.timeline),
  };
}

export function formatRefundAmount(amount: RefundAmount): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency }).format(amount.amountMinor / 100);
}

export function formatRefundDestination(destination: string): string {
  switch (destination) {
    case "ORIGINAL_PAYMENT_METHOD":
    case "Original payment method":
      return "Original payment method";
    case "STORE_CREDIT":
    case "Store credit":
      return "Store credit";
    case "OTHER":
    case "Other refund destination":
      return "Other refund destination";
    default:
      return "the designated refund destination";
  }
}

export function getRefundReviewDeadline(journey: RefundJourney): string | undefined {
  return journey.nextAction === "CONFIRM_OR_DECLINE" ? journey.preview?.expiresAt : undefined;
}

export function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
