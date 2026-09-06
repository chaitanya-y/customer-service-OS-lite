import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HumanAccess } from './human-access.js';
import type { HumanCase, RefundReviewPacket } from './human-case.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_SET_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTOS = 5;
export const MAX_UPLOAD_ATTEMPTS = 20;
export const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const evidenceWorkflowId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const expectedVersion = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const evidenceReviewSchema = z.object({
  version: z.literal('v1'),
  action: z.enum(['ACCEPT_EVIDENCE', 'REQUEST_MORE_EVIDENCE']),
  expected_case_version: expectedVersion.min(1),
  expected_evidence_version: expectedVersion.min(1),
  reason_code: z.enum(['DAMAGE_VISIBLE', 'PHOTO_UNCLEAR', 'DAMAGED_ITEM_NOT_VISIBLE', 'ORDER_ITEM_NOT_IDENTIFIABLE']),
  note: z.string().min(1).max(2000).regex(/\S/).optional(),
}).strict().superRefine((value, context) => {
  if ((value.action === 'ACCEPT_EVIDENCE') !== (value.reason_code === 'DAMAGE_VISIBLE'))
    context.addIssue({ code: 'custom', path: ['reason_code'], message: 'Reason does not match review action' });
});
export type EvidenceReview = z.infer<typeof evidenceReviewSchema>;
export type EvidenceScope = Readonly<{ tenantId: string; environmentId: string; subjectCustomerId?: string }>;
export type EvidenceBinding = Readonly<{ order_id: string; proposal_id: string; selected_item_ids: readonly string[]; policy_version: string }>;
export type EvidencePhoto = {
  evidence_id: string; display_label: string; byte_size: number; uploaded_at: string;
  technical_status: 'PROCESSING' | 'READY' | 'REJECTED';
  content_type?: 'image/jpeg' | 'image/png'; width?: number; height?: number;
  rejection_code?: 'FILE_TOO_LARGE' | 'UNSUPPORTED_TYPE' | 'INVALID_IMAGE' | 'IMAGE_LIMIT_EXCEEDED' | 'UNSAFE_FILE' | 'VALIDATION_UNAVAILABLE';
};
export type EvidenceSummary = {
  version: 'v1'; requirement: 'DAMAGE_PHOTO'; evidence_version: number;
  assessment: 'UNREVIEWED' | 'ACCEPTED' | 'MORE_REQUIRED';
  can_upload: boolean; customer_message_code?: string; attachments: EvidencePhoto[];
};
export type StoredPhoto = EvidencePhoto & {
  storageKey: string; sha256?: string; uploadKey: string; fingerprint: string; purged?: boolean;
  // Logical revision history only: superseding never deletes a normalized photo.
  superseded?: boolean;
};
export type EvidenceDocument = {
  revision: number; assessment: EvidenceSummary['assessment']; reasonCode?: string;
  assessmentId?: string; manifestHash?: string; ensureFingerprint: string;
  attachments: StoredPhoto[]; reviewKeys: Record<string, string>; transitionKeys: Record<string, string>;
  retired?: boolean;
};
export type EvidenceSnapshot = {
  case_id: string; case_status: HumanCase['status']; evidence: EvidenceSummary; binding: EvidenceBinding;
  accepted_manifest_hash?: string; assessment_id?: string;
};
export type EvidenceRecord = {
  case: HumanCase; customerId: string; binding: EvidenceBinding; document: EvidenceDocument;
};
export type EnsureEvidenceInput = EvidenceBinding & { scope: EvidenceScope & { subjectCustomerId: string }; workflowId: string; reviewPacket: RefundReviewPacket; idempotencyKey: string };
export type TransitionEvidenceInput = {
  scope: EvidenceScope; workflowId: string; caseType: 'REFUND_APPROVAL' | 'REFUND_TAKEOVER';
  reviewPacket: RefundReviewPacket; policyVersion: string; expectedEvidenceVersion: number; idempotencyKey: string;
};
export class EvidenceError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export function canReviewEvidence(access: HumanAccess, record: EvidenceRecord): boolean {
  return ['REFUND_APPROVER','REFUND_SUPERVISOR'].includes(access.role)
    && record.case.caseType === 'REFUND_EVIDENCE_REVIEW' && record.case.status === 'CLAIMED'
    && record.case.tenantId === access.tenantId && record.case.environmentId === access.environmentId
    && record.case.assignedStaffId === access.staffId && record.document.assessment !== 'ACCEPTED'
    && record.document.attachments.some(p => p.technical_status === 'READY' && !p.purged && !p.superseded)
    && !record.document.attachments.some(p => p.technical_status === 'PROCESSING' && !p.superseded);
}
export function evidenceSnapshot(record: EvidenceRecord): EvidenceSnapshot {
  const doc = record.document;
  const available = doc.attachments.filter(p => !p.purged && !p.superseded);
  const readyOrProcessing = available.filter(p => p.technical_status !== 'REJECTED');
  const visible = doc.assessment === 'ACCEPTED'
    ? available.filter(p => p.technical_status === 'READY')
    : [...readyOrProcessing, ...available.filter(p => p.technical_status === 'REJECTED').slice(-(MAX_PHOTOS - readyOrProcessing.length))].slice(0, MAX_PHOTOS);
  const evidence: EvidenceSummary = {
    version: 'v1', requirement: 'DAMAGE_PHOTO', evidence_version: doc.revision,
    assessment: doc.retired ? 'UNREVIEWED' : doc.assessment,
    can_upload: !doc.retired && doc.assessment !== 'ACCEPTED' && record.case.caseType === 'REFUND_EVIDENCE_REVIEW'
      && ['OPEN','CLAIMED'].includes(record.case.status) && readyOrProcessing.length < MAX_PHOTOS && doc.attachments.length < MAX_UPLOAD_ATTEMPTS
      && readyOrProcessing.reduce((sum,p)=>sum+p.byte_size,0) < MAX_SET_BYTES,
    attachments: doc.retired ? [] : visible.map((photo, index) => ({
      evidence_id: photo.evidence_id, display_label: `Photo ${index + 1}`, byte_size: photo.byte_size,
      uploaded_at: photo.uploaded_at, technical_status: photo.technical_status,
      ...(photo.content_type ? { content_type: photo.content_type } : {}),
      ...(photo.width === undefined ? {} : { width: photo.width, height: photo.height! }),
      ...(photo.rejection_code ? { rejection_code: photo.rejection_code } : {}),
    })),
    ...(!doc.retired && doc.assessment === 'MORE_REQUIRED' && doc.reasonCode ? { customer_message_code: doc.reasonCode } : {}),
  };
  return { case_id: record.case.caseId, case_status: record.case.status, evidence, binding: record.binding,
    ...(doc.manifestHash ? { accepted_manifest_hash: doc.manifestHash } : {}),
    ...(doc.assessmentId ? { assessment_id: doc.assessmentId } : {}),
  };
}
export interface RefundEvidenceRepository {
  ensure(input: EnsureEvidenceInput): Promise<EvidenceSnapshot>;
  get(scope: EvidenceScope, workflowId: string): Promise<EvidenceRecord>;
  beginUpload(input: { scope: EvidenceScope; workflowId: string; expectedRevision: number; idempotencyKey: string; fingerprint: string; byteSize: number; contentType: 'image/jpeg' | 'image/png' }): Promise<{ record: EvidenceRecord; photo: StoredPhoto; created: boolean }>;
  finishUpload(scope: EvidenceScope, workflowId: string, evidenceId: string, result: { contentType: 'image/jpeg' | 'image/png'; byteSize: number; width: number; height: number; sha256: string } | { rejectionCode: NonNullable<EvidencePhoto['rejection_code']> }): Promise<EvidenceSnapshot>;
  review(input: { scope: EvidenceScope; workflowId: string; access: HumanAccess; command: EvidenceReview; idempotencyKey: string }): Promise<EvidenceSnapshot>;
  transition(input: TransitionEvidenceInput): Promise<EvidenceSnapshot>;
  recoverStaleUploads(scope: EvidenceScope): Promise<void>;
  purge(scope: EvidenceScope, options: { retentionDays: number; remove: (key: string) => Promise<void>; now?: Date }): Promise<void>;
}
