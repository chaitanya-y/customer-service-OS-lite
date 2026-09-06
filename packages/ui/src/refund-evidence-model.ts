/** Display projection of contracts/customer-api/refund-evidence/v1; never authorization. */
export type EvidenceMessageCode = "PHOTO_UNCLEAR" | "DAMAGED_ITEM_NOT_VISIBLE" | "ORDER_ITEM_NOT_IDENTIFIABLE";
export type EvidenceRejectionCode = "FILE_TOO_LARGE" | "UNSUPPORTED_TYPE" | "INVALID_IMAGE" | "IMAGE_LIMIT_EXCEEDED" | "UNSAFE_FILE" | "VALIDATION_UNAVAILABLE";
export type EvidenceAttachment = Readonly<{
  evidenceId: string;
  displayLabel: string;
  byteSize: number;
  uploadedAt: string;
  technicalStatus: "PROCESSING" | "READY" | "REJECTED";
  contentType?: "image/jpeg" | "image/png";
  width?: number;
  height?: number;
  rejectionCode?: EvidenceRejectionCode;
}>;
export type RefundEvidence = Readonly<{
  requirement: "DAMAGE_PHOTO" | "NONE";
  evidenceVersion: number;
  assessment: "UNREVIEWED" | "ACCEPTED" | "MORE_REQUIRED";
  canUpload: boolean;
  customerMessageCode?: EvidenceMessageCode;
  attachments: readonly EvidenceAttachment[];
}>;

export const MAX_EVIDENCE_UPLOAD_BYTES = 10 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messageCodes: readonly string[] = ["PHOTO_UNCLEAR", "DAMAGED_ITEM_NOT_VISIBLE", "ORDER_ITEM_NOT_IDENTIFIABLE"];
const rejectionCodes: readonly string[] = ["FILE_TOO_LARGE", "UNSUPPORTED_TYPE", "INVALID_IMAGE", "IMAGE_LIMIT_EXCEEDED", "UNSAFE_FILE", "VALIDATION_UNAVAILABLE"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizeAttachment(value: unknown): EvidenceAttachment | undefined {
  const data = record(value);
  if (!data || typeof data.evidence_id !== "string" || !uuidPattern.test(data.evidence_id)
    || typeof data.display_label !== "string" || !/^Photo [1-5]$/.test(data.display_label)
    || !integer(data.byte_size) || typeof data.uploaded_at !== "string"
    || !Number.isFinite(Date.parse(data.uploaded_at))
    || !["PROCESSING", "READY", "REJECTED"].includes(String(data.technical_status))) return undefined;
  const status = data.technical_status as EvidenceAttachment["technicalStatus"];
  const contentType = data.content_type;
  if (contentType !== undefined && contentType !== "image/jpeg" && contentType !== "image/png") return undefined;
  if (status === "READY" && (!contentType || !integer(data.width, 1, 65535)
    || !integer(data.height, 1, 65535) || data.byte_size < 1)) return undefined;
  if (status !== "READY" && (data.width !== undefined || data.height !== undefined)) return undefined;
  if (status === "REJECTED" ? !rejectionCodes.includes(String(data.rejection_code)) : data.rejection_code !== undefined) return undefined;
  return {
    evidenceId: data.evidence_id,
    displayLabel: data.display_label,
    byteSize: data.byte_size,
    uploadedAt: data.uploaded_at,
    technicalStatus: status,
    ...(contentType ? { contentType } : {}),
    ...(status === "READY" ? { width: data.width as number, height: data.height as number } : {}),
    ...(status === "REJECTED" ? { rejectionCode: data.rejection_code as EvidenceRejectionCode } : {}),
  };
}

export function normalizeRefundEvidence(value: unknown): RefundEvidence | undefined {
  const data = record(value);
  if (!data || data.version !== "v1" || !["DAMAGE_PHOTO", "NONE"].includes(String(data.requirement))
    || !integer(data.evidence_version) || typeof data.can_upload !== "boolean"
    || !["UNREVIEWED", "ACCEPTED", "MORE_REQUIRED"].includes(String(data.assessment))
    || !Array.isArray(data.attachments) || data.attachments.length > 5) return undefined;
  const attachments = data.attachments.map(normalizeAttachment);
  if (attachments.some((attachment) => !attachment)) return undefined;
  const photos = attachments as EvidenceAttachment[];
  if (new Set(photos.map((photo) => photo.evidenceId.toLowerCase())).size !== photos.length) return undefined;
  if (data.assessment === "MORE_REQUIRED"
    ? !messageCodes.includes(String(data.customer_message_code)) || data.evidence_version < 1
    : data.customer_message_code !== undefined) return undefined;
  if (data.evidence_version === 0 && (photos.length > 0 || data.assessment !== "UNREVIEWED")) return undefined;
  if (data.requirement === "NONE" && (data.can_upload || data.evidence_version !== 0
    || photos.length > 0 || data.assessment !== "UNREVIEWED")) return undefined;
  if (data.assessment === "ACCEPTED" && (data.requirement !== "DAMAGE_PHOTO" || data.can_upload
    || photos.length === 0 || photos.some((photo) => photo.technicalStatus !== "READY"))) return undefined;
  return {
    requirement: data.requirement as RefundEvidence["requirement"],
    evidenceVersion: data.evidence_version,
    assessment: data.assessment as RefundEvidence["assessment"],
    canUpload: data.can_upload,
    ...(data.customer_message_code ? { customerMessageCode: data.customer_message_code as EvidenceMessageCode } : {}),
    attachments: photos,
  };
}

export function evidenceMessage(code: EvidenceMessageCode | undefined): string {
  switch (code) {
    case "PHOTO_UNCLEAR": return "Please add a clearer, well-lit photo of the damage.";
    case "DAMAGED_ITEM_NOT_VISIBLE": return "Please add a photo that clearly shows the damaged item.";
    case "ORDER_ITEM_NOT_IDENTIFIABLE": return "Please add a photo that helps identify the item from this order.";
    default: return "A specialist needs another photo before the review can continue.";
  }
}

export function evidenceStatusMessage(evidence: RefundEvidence): string {
  if (evidence.assessment === "ACCEPTED") return "A specialist accepted these photos as damage evidence. This does not approve a refund.";
  if (evidence.assessment === "MORE_REQUIRED") return evidence.canUpload ? evidenceMessage(evidence.customerMessageCode) : "The specialist requested another photo, but uploads are no longer available for this request.";
  if (evidence.attachments.some((photo) => photo.technicalStatus === "PROCESSING")) return "We are checking your photo files. They still need specialist review.";
  if (evidence.attachments.some((photo) => photo.technicalStatus === "READY")) return "Photos received. A specialist will review them before the request can continue.";
  return evidence.canUpload ? "Add photos that show the damaged item. A specialist will review them." : "No reviewable photos are available for this request.";
}

export function evidenceRejectionMessage(code: EvidenceRejectionCode | undefined): string {
  switch (code) {
    case "FILE_TOO_LARGE": return "This photo is too large. Choose a photo under 10 MB.";
    case "UNSUPPORTED_TYPE": return "Choose a JPEG or PNG photo.";
    case "IMAGE_LIMIT_EXCEEDED": return "This photo's dimensions are too large. Choose a smaller image.";
    case "VALIDATION_UNAVAILABLE": return "We could not check this photo. Please try uploading it again.";
    case "UNSAFE_FILE": return "We could not safely process this file. Choose another photo.";
    default: return "We could not read this image. Choose another JPEG or PNG photo.";
  }
}

export function validateEvidenceFile(file: Readonly<{ type: string; size: number }>): string | undefined {
  if (file.type !== "image/jpeg" && file.type !== "image/png") return "Choose a JPEG or PNG photo.";
  if (file.size === 0) return "This file is empty. Choose another photo.";
  if (file.size > MAX_EVIDENCE_UPLOAD_BYTES) return "Choose a photo under 10 MB.";
  return undefined;
}

export function hasReviewableEvidence(evidence: RefundEvidence | undefined): boolean {
  return Boolean(evidence && evidence.assessment !== "ACCEPTED" && evidence.evidenceVersion > 0
    && evidence.attachments.some((photo) => photo.technicalStatus === "READY")
    && !evidence.attachments.some((photo) => photo.technicalStatus === "PROCESSING"));
}

export function evidenceRequestError(status: number, code?: string): string {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403 || status === 404) return "These photos are not available for this request.";
  if (code === "evidence_limit_exceeded") return "This request has reached its photo limit. Please contact support if you need more help.";
  if (code === "evidence_frozen") return "These photos have already been reviewed. No more uploads are available.";
  if (status === 409) return "The request or photos changed. Refresh and review the latest details before trying again.";
  if (status === 413) return "Choose a photo under 10 MB.";
  if (status === 415) return "Choose a JPEG or PNG photo.";
  if (status === 400 || status === 422) return "We could not accept this photo or review. Check the details and try again.";
  return "The photo service is temporarily unavailable. Please try again.";
}
