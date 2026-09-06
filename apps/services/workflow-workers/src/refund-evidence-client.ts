import { z } from 'zod';

import { toHumanOperationsReviewPacket } from './human-operations-case-client.js';
import type { OpenHumanCaseInput, RefreshRefundContextInput } from './refund-workflow-activities.js';
import type { SignWorkflowAccessAssertion, WorkflowAccessAssertionInput } from './workflow-access-assertion.js';

const snapshotSchema = z.object({
  case_id: z.string().min(1),
  case_status: z.enum(['OPEN', 'CLAIMED', 'DECISION_PENDING', 'CLOSED']),
  evidence: z.object({
    version: z.literal('v1'),
    requirement: z.literal('DAMAGE_PHOTO'),
    evidence_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    assessment: z.enum(['UNREVIEWED', 'ACCEPTED', 'MORE_REQUIRED']),
    can_upload: z.boolean(),
    attachments: z.array(z.object({
      evidence_id: z.uuid(),
      technical_status: z.enum(['PROCESSING', 'READY', 'REJECTED']),
    }).passthrough()).max(5),
  }).passthrough(),
  binding: z.object({
    order_id: z.string().min(1), proposal_id: z.string().min(1),
    selected_item_ids: z.array(z.string().min(1)), policy_version: z.string().min(1),
  }).strict(),
  accepted_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  assessment_id: z.uuid().optional(),
}).strict();

export type AcceptedDamageEvidence = Readonly<{
  evidenceVersion: number; assessmentId: string; manifestHash: string; observedAt: string;
}>;
export type EvidenceSnapshot = Readonly<{
  caseId: string; assessment: 'UNREVIEWED' | 'ACCEPTED' | 'MORE_REQUIRED';
  evidenceVersion: number; readyCount: number; processingCount: number;
  accepted?: AcceptedDamageEvidence;
}>;
export type EvidenceAccess = RefreshRefundContextInput & Readonly<{ policyVersion: string }>;
export type RefundEvidenceActivities = Readonly<{
  openRefundEvidence(input: OpenHumanCaseInput): Promise<EvidenceSnapshot>;
  readRefundEvidence(input: EvidenceAccess): Promise<EvidenceSnapshot>;
  transitionRefundEvidence(input: OpenHumanCaseInput & { evidenceVersion: number }): Promise<{ caseId: string }>;
  closeRefundEvidence(input: EvidenceAccess & {
    caseId: string; outcome: 'EVIDENCE_REVIEW_COMPLETED' | 'EVIDENCE_COLLECTION_EXPIRED';
  }): Promise<void>;
}>;

/** Scope is verified both by the receiving service and by this response boundary. */
export function parseEvidenceSnapshot(data: unknown, input: EvidenceAccess, now = new Date()): EvidenceSnapshot {
  const value = snapshotSchema.parse(data);
  const expected = input.proposal.intent;
  if (value.binding.order_id !== expected.orderId || value.binding.proposal_id !== input.proposal.proposalId
    || value.binding.policy_version !== input.policyVersion
    || JSON.stringify([...value.binding.selected_item_ids].sort()) !== JSON.stringify([...expected.itemIds].sort())) {
    throw new Error('REFUND_EVIDENCE_BINDING_MISMATCH');
  }
  const files = value.evidence.attachments;
  if (new Set(files.map((file) => file.evidence_id)).size !== files.length) throw new Error('DUPLICATE_EVIDENCE_ID');
  const accepted = value.evidence.assessment === 'ACCEPTED';
  if (accepted && (value.evidence.can_upload || value.evidence.evidence_version < 1
    || files.length === 0 || files.some((file) => file.technical_status !== 'READY')
    || value.accepted_manifest_hash === undefined || value.assessment_id === undefined)) {
    throw new Error('INVALID_ACCEPTED_EVIDENCE');
  }
  return {
    caseId: value.case_id, assessment: value.evidence.assessment,
    evidenceVersion: value.evidence.evidence_version,
    readyCount: files.filter((file) => file.technical_status === 'READY').length,
    processingCount: files.filter((file) => file.technical_status === 'PROCESSING').length,
    ...(accepted ? { accepted: {
      evidenceVersion: value.evidence.evidence_version,
      assessmentId: value.assessment_id!, manifestHash: value.accepted_manifest_hash!, observedAt: now.toISOString(),
    } } : {}),
  };
}

export function createRefundEvidenceClient(options: {
  baseUrl: string; signWorkflowAccessAssertion: SignWorkflowAccessAssertion;
  expectedTenantId: string; expectedEnvironmentId: string;
  fetchImpl?: typeof fetch;
}): RefundEvidenceActivities {
  async function call(input: { workflowId: string; access: EvidenceAccess['access'] },
    path: string, purpose: WorkflowAccessAssertionInput['purpose'], body?: unknown, idempotencyKey?: string) {
    if (input.access.tenantId !== options.expectedTenantId || input.access.environmentId !== options.expectedEnvironmentId)
      throw new Error('WORKFLOW_ACCESS_SCOPE_MISMATCH');
    const assertion = await options.signWorkflowAccessAssertion({ ...input, purpose });
    const response = await (options.fetchImpl ?? fetch)(new URL(path, options.baseUrl), {
      redirect: 'error',
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-cso-workflow-assertion': assertion,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`REFUND_EVIDENCE_UNAVAILABLE_${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('EMPTY_EVIDENCE_RESPONSE');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 65_536) throw new Error('EVIDENCE_RESPONSE_TOO_LARGE');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  }
  const path = (id: string) => `/internal/v1/refund-evidence/${encodeURIComponent(id)}`;
  return {
    async openRefundEvidence(input) {
      const data = await call(input, '/internal/v1/refund-evidence/collections', 'refund_evidence_open', {
        workflow_id: input.workflowId, order_id: input.reviewPacket.proposal.orderId,
        proposal_id: input.reviewPacket.proposal.proposalId,
        selected_item_ids: input.reviewPacket.proposal.itemIds,
        review_packet: toHumanOperationsReviewPacket(input), policy_version: input.reviewPacket.policy.policyVersion,
      }, `workflow:${input.workflowId}:evidence:open`);
      return parseEvidenceSnapshot(data, { ...input,
        proposal: { journeyType: 'REFUND', proposalId: input.reviewPacket.proposal.proposalId, intent: input.reviewPacket.proposal },
        policyVersion: input.reviewPacket.policy.policyVersion,
      });
    },
    async readRefundEvidence(input) {
      return parseEvidenceSnapshot(await call(input, path(input.workflowId), 'refund_evidence_read'), input);
    },
    async transitionRefundEvidence(input) {
      const data = await call(input, `${path(input.workflowId)}/transition`, 'human_case_transition', {
        case_type: input.caseType, review_packet: toHumanOperationsReviewPacket(input),
        policy_version: input.reviewPacket.policy.policyVersion, expected_evidence_version: input.evidenceVersion,
      }, `workflow:${input.workflowId}:evidence:transition:${input.caseType}:${input.evidenceVersion}`);
      const result = z.object({ refund_case: z.object({ case_id: z.string().min(1) }).passthrough() }).passthrough().parse(data);
      return { caseId: result.refund_case.case_id };
    },
    async closeRefundEvidence(input) {
      await call(input, `/internal/v1/refund-cases/${encodeURIComponent(input.caseId)}/close`, 'human_case_close',
        { workflow_id: input.workflowId, outcome: input.outcome }, `workflow:${input.workflowId}:evidence:close:${input.outcome}`);
    },
  };
}
