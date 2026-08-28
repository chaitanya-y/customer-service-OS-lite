import { z } from 'zod';

export const humanCaseTypeSchema = z.enum(['REFUND_APPROVAL', 'REFUND_TAKEOVER']);
export const humanCaseStatusSchema = z.enum(['OPEN', 'CLAIMED', 'DECISION_PENDING', 'CLOSED']);
export const humanDecisionSchema = z.enum([
  'APPROVE',
  'REJECT',
  'RESOLVE_TAKEOVER',
  'APPROVE_EXCEPTIONAL_REFUND',
]);

export type HumanCaseType = z.infer<typeof humanCaseTypeSchema>;
export type HumanCaseStatus = z.infer<typeof humanCaseStatusSchema>;
export type HumanDecision = z.infer<typeof humanDecisionSchema>;

/**
 * A deliberately small, customer-safe snapshot. Sensitive commerce/provider data
 * stays behind the Integration Gateway and is never copied into an operations case.
 */
export const refundReviewPacketSchema = z.object({
  order_reference: z.string().min(1).max(200).optional(),
  selected_item_ids: z.array(z.string().min(1).max(200)).max(100).optional(),
  requested_amount: z.object({
    amount_minor: z.number().int().nonnegative(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }).strict().optional(),
  refund_reason: z.string().min(1).max(2_000).optional(),
  policy_reason_codes: z.array(z.string().min(1).max(160)).max(50),
  evidence_ids: z.array(z.string().min(1).max(200)).max(100),
  knowledge_release_id: z.string().min(1).max(200).optional(),
  policy_version: z.string().min(1).max(200),
}).strict();

export type RefundReviewPacket = z.infer<typeof refundReviewPacketSchema>;

export type HumanCase = Readonly<{
  caseId: string;
  tenantId: string;
  environmentId: string;
  workflowId: string;
  caseType: HumanCaseType;
  status: HumanCaseStatus;
  allowedActions: readonly HumanDecision[];
  assignedStaffId?: string;
  caseVersion: number;
  reviewPacket: RefundReviewPacket;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}>;

export type HumanCaseAuditEvent = Readonly<{
  eventId: string;
  caseId: string;
  eventType: 'CASE_OPENED' | 'CASE_CLAIMED' | 'DECISION_RECORDED' | 'CASE_CLOSED';
  occurredAt: string;
  actorType: 'WORKFLOW' | 'HUMAN';
  actorId: string;
  caseVersion: number;
  details: Readonly<Record<string, string>>;
}>;

export type HumanDecisionOutboxEvent = Readonly<{
  eventId: string;
  caseId: string;
  workflowId: string;
  tenantId: string;
  environmentId: string;
  decision: HumanDecision;
  decidedBy: string;
  decidedAt: string;
  reasonCode?: string;
  note?: string;
  createdAt: string;
}>;

export function allowedActionsForCaseType(caseType: HumanCaseType): readonly HumanDecision[] {
  return caseType === 'REFUND_APPROVAL'
    ? ['APPROVE', 'REJECT']
    : ['APPROVE_EXCEPTIONAL_REFUND', 'RESOLVE_TAKEOVER', 'REJECT'];
}

export function isAllowedDecisionForCaseType(caseType: HumanCaseType, decision: HumanDecision): boolean {
  return allowedActionsForCaseType(caseType).includes(decision);
}
