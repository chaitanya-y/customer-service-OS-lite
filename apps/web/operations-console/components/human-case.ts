import { hasReviewableEvidence, normalizeRefundEvidence, type EvidenceMessageCode, type RefundEvidence } from "@cso/ui/refund-evidence-model";

export type EvidenceReviewAction = "ACCEPT_EVIDENCE" | "REQUEST_MORE_EVIDENCE";
export type EvidenceReviewReason = "DAMAGE_VISIBLE" | EvidenceMessageCode;

export type HumanCaseAction =
  | "APPROVE"
  | "REJECT"
  | "RESOLVE_TAKEOVER"
  | "APPROVE_EXCEPTIONAL_REFUND";

export type ReviewPacket = Readonly<{
  evidenceIds: string[];
  knowledgeReleaseId?: string;
  orderReference?: string;
  policyReasonCodes: string[];
  policyVersion?: string;
  refundReason?: string;
  requestedAmount?: Readonly<{ amountMinor: number; currency: string }>;
  selectedItemIds: string[];
}>;

export type HumanCase = Readonly<{
  allowedActions: HumanCaseAction[];
  allowedEvidenceActions: EvidenceReviewAction[];
  evidence?: RefundEvidence;
  assignedStaffId?: string;
  canClaim: boolean;
  caseId: string;
  caseType: "REFUND_APPROVAL" | "REFUND_TAKEOVER" | "REFUND_EVIDENCE_REVIEW";
  caseVersion: number;
  createdAt: string;
  decidedAt?: string;
  policyVersion?: string;
  reviewPacket: ReviewPacket;
  status: "OPEN" | "CLAIMED" | "DECISION_PENDING" | "CLOSED";
  updatedAt: string;
  workflowId: string;
}>;

export type AuditEvent = Readonly<{
  actorId?: string;
  createdAt?: string;
  eventType?: string;
  note?: string;
}>;

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function asActionArray(value: unknown): HumanCaseAction[] {
  return asStringArray(value).filter((entry): entry is HumanCaseAction =>
    entry === "APPROVE" || entry === "REJECT" || entry === "RESOLVE_TAKEOVER" ||
    entry === "APPROVE_EXCEPTIONAL_REFUND",
  );
}

function asAmount(value: unknown): ReviewPacket["requestedAmount"] {
  const record = asRecord(value);
  const amountMinor = record?.amount_minor;
  const currency = asString(record?.currency);
  return typeof amountMinor === "number" && Number.isFinite(amountMinor) && currency
    ? { amountMinor, currency }
    : undefined;
}

function asCaseType(value: unknown): HumanCase["caseType"] | undefined {
  return value === "REFUND_APPROVAL" || value === "REFUND_TAKEOVER" || value === "REFUND_EVIDENCE_REVIEW" ? value : undefined;
}

function asStatus(value: unknown): HumanCase["status"] | undefined {
  return value === "OPEN" || value === "CLAIMED" || value === "DECISION_PENDING" || value === "CLOSED"
    ? value
    : undefined;
}

export function normalizeHumanCase(value: unknown): HumanCase | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const reviewPacket = asRecord(record.review_packet) ?? {};
  const caseId = asString(record.case_id);
  const workflowId = asString(record.workflow_id);
  const caseType = asCaseType(record.case_type);
  const status = asStatus(record.status);
  const caseVersion = record.case_version;
  const createdAt = asString(record.created_at);
  const updatedAt = asString(record.updated_at);
  const evidence = normalizeRefundEvidence(record.evidence);

  if (
    !caseId || !workflowId || !caseType || !status ||
    typeof caseVersion !== "number" || !Number.isSafeInteger(caseVersion) || caseVersion < 1 || !createdAt || !updatedAt
  ) return undefined;

  return {
    allowedActions: caseType === "REFUND_EVIDENCE_REVIEW" ? [] : asActionArray(record.allowed_actions),
    allowedEvidenceActions: caseType === "REFUND_EVIDENCE_REVIEW" && status === "CLAIMED" && asString(record.assigned_staff_id) && hasReviewableEvidence(evidence)
      ? asStringArray(record.allowed_evidence_actions).filter((action): action is EvidenceReviewAction => action === "ACCEPT_EVIDENCE" || action === "REQUEST_MORE_EVIDENCE") : [],
    ...(evidence ? { evidence } : {}),
    ...(asString(record.assigned_staff_id) ? { assignedStaffId: asString(record.assigned_staff_id) } : {}),
    canClaim: record.can_claim === true,
    caseId,
    caseType,
    caseVersion,
    createdAt,
    ...(asString(record.decided_at) ? { decidedAt: asString(record.decided_at) } : {}),
    ...(asString(record.policy_version) ? { policyVersion: asString(record.policy_version) } : {}),
    reviewPacket: {
      evidenceIds: asStringArray(reviewPacket.evidence_ids),
      ...(asString(reviewPacket.knowledge_release_id) ? { knowledgeReleaseId: asString(reviewPacket.knowledge_release_id) } : {}),
      ...(asString(reviewPacket.order_reference) ? { orderReference: asString(reviewPacket.order_reference) } : {}),
      policyReasonCodes: asStringArray(reviewPacket.policy_reason_codes),
      ...(asString(reviewPacket.policy_version) ? { policyVersion: asString(reviewPacket.policy_version) } : {}),
      ...(asString(reviewPacket.refund_reason) ? { refundReason: asString(reviewPacket.refund_reason) } : {}),
      ...(asAmount(reviewPacket.requested_amount) ? { requestedAmount: asAmount(reviewPacket.requested_amount) } : {}),
      selectedItemIds: asStringArray(reviewPacket.selected_item_ids),
    },
    status,
    updatedAt,
    workflowId,
  };
}

export function normalizeHumanCaseList(value: unknown): HumanCase[] {
  const record = asRecord(value);
  const cases = record?.refund_cases;
  return Array.isArray(cases)
    ? cases.map(normalizeHumanCase).filter((item): item is HumanCase => Boolean(item))
    : [];
}

export function normalizeAuditEvents(value: unknown): AuditEvent[] {
  const record = asRecord(value);
  const events = record?.audit_events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    const data = asRecord(event);
    if (!data) return [];
    const details = asRecord(data.details);
    const occurredAt = asString(data.occurred_at) ?? asString(data.created_at);
    const note = asString(details?.note) ?? asString(data.note);
    return [{
      ...(asString(data.actor_id) ? { actorId: asString(data.actor_id) } : {}),
      ...(occurredAt ? { createdAt: occurredAt } : {}),
      ...(asString(data.event_type) ? { eventType: asString(data.event_type) } : {}),
      ...(note ? { note } : {}),
    }];
  });
}

export function getApiErrorMessage(value: unknown, fallback: string): string {
  const record = asRecord(value);
  const error = asRecord(record?.error);
  return asString(error?.message) ?? fallback;
}

export function formatMoney(amount: NonNullable<ReviewPacket["requestedAmount"]>) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: amount.currency }).format(amount.amountMinor / 100);
}

export function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function actionLabel(action: HumanCaseAction) {
  return action === "APPROVE"
    ? "Approve refund"
    : action === "APPROVE_EXCEPTIONAL_REFUND"
      ? "Approve exceptional refund plan"
    : action === "REJECT"
      ? "Reject request"
      : "Resolve manual takeover";
}

export function caseTypeLabel(type: HumanCase["caseType"]): string {
  return type === "REFUND_EVIDENCE_REVIEW" ? "Damage evidence review" : type === "REFUND_APPROVAL" ? "Refund approval" : "Manual refund takeover";
}

export function buildEvidenceReviewCommand(refundCase: HumanCase, action: EvidenceReviewAction, reason: EvidenceReviewReason, note: string) {
  if (!refundCase.allowedEvidenceActions.includes(action) || !refundCase.evidence || !hasReviewableEvidence(refundCase.evidence)) {
    throw new Error("This evidence review is no longer available. Refresh the case.");
  }
  if (action === "ACCEPT_EVIDENCE" ? reason !== "DAMAGE_VISIBLE" : !["PHOTO_UNCLEAR", "DAMAGED_ITEM_NOT_VISIBLE", "ORDER_ITEM_NOT_IDENTIFIABLE"].includes(reason)) {
    throw new Error("Choose a reason for this evidence review.");
  }
  if (note.trim().length > 2000) throw new Error("Keep the internal note under 2,000 characters.");
  return { version: "v1" as const, action, expected_case_version: refundCase.caseVersion,
    expected_evidence_version: refundCase.evidence.evidenceVersion, reason_code: reason,
    ...(note.trim() ? { note: note.trim() } : {}),
  };
}
