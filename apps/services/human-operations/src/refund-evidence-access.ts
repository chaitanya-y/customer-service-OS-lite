import { jwtVerify } from 'jose';
import { z } from 'zod';
import { evidenceWorkflowId, opaqueId } from './refund-evidence.js';
export const EVIDENCE_ASSERTION_HEADER = 'x-cso-evidence-assertion';
export type EvidencePurpose = 'refund_evidence_read' | 'refund_evidence_upload' | 'refund_evidence_content';
const claimsSchema = z.object({
  accessVersion: z.literal('1'),
  workflow: z.object({ workflowId: evidenceWorkflowId }).strict(),
  tenant: z.object({ tenantId: opaqueId, environmentId: opaqueId }).strict(),
  subject: z.object({ customerId: opaqueId }).strict(),
  purpose: z.enum(['refund_evidence_read', 'refund_evidence_upload', 'refund_evidence_content']),
  request: z.object({ requestId: opaqueId, traceId: opaqueId }).strict(),
  iss: z.string(), aud: z.string(), iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
}).strict();
export type CustomerEvidenceAccess = { tenantId: string; environmentId: string; subjectCustomerId: string; workflowId: string };
export type VerifyEvidenceAccess = (assertion: string | undefined, purpose: EvidencePurpose) => Promise<CustomerEvidenceAccess>;
export function createEvidenceAccessVerifier(options: { secret: string; issuer: string; tenantId: string; environmentId: string; now?: () => Date }): VerifyEvidenceAccess {
  if (Buffer.byteLength(options.secret) < 32) throw new Error('INVALID_EVIDENCE_AUTH_CONFIG');
  return async (assertion, purpose) => {
    try {
      if (!assertion || assertion.length > 8192) throw new Error();
      const now = options.now?.() ?? new Date();
      const { payload } = await jwtVerify(assertion, new TextEncoder().encode(options.secret), { algorithms: ['HS256'], issuer: options.issuer, audience: 'human-operations-evidence', typ: 'cso-evidence+jwt', currentDate: now });
      const claims = claimsSchema.parse(payload);
      if (claims.purpose !== purpose || claims.tenant.tenantId !== options.tenantId || claims.tenant.environmentId !== options.environmentId || claims.iat > Math.floor(now.getTime()/1000) + 30 || claims.exp <= Math.floor(now.getTime()/1000) || claims.exp <= claims.iat || claims.exp - claims.iat > 60) throw new Error();
      return { tenantId: claims.tenant.tenantId, environmentId: claims.tenant.environmentId, subjectCustomerId: claims.subject.customerId, workflowId: claims.workflow.workflowId };
    } catch { throw new Error('EVIDENCE_UNAUTHORIZED'); }
  };
}
