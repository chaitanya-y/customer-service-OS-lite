import { jwtVerify } from 'jose';
import { z } from 'zod';

export const WORKFLOW_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const opaqueId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const claimsSchema = z.object({
  accessVersion: z.literal('1'),
  workflow: z.object({ workflowId: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/) }).strict(),
  tenant: z.object({ tenantId: opaqueId, environmentId: opaqueId }).strict(),
  subject: z.object({ customerId: opaqueId }).strict(),
  purpose: z.enum(['human_case_open', 'human_case_close', 'refund_evidence_open', 'refund_evidence_read', 'human_case_transition']),
  request: z.object({ requestId: opaqueId, traceId: opaqueId }).strict(),
  iss: z.string().min(1).max(200),
  aud: z.string().min(1).max(200),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();

export type WorkflowCaseAccess = Readonly<{
  workflowId: string;
  tenantId: string;
  environmentId: string;
  subjectCustomerId: string;
  purpose: 'human_case_open' | 'human_case_close' | 'refund_evidence_open' | 'refund_evidence_read' | 'human_case_transition';
}>;

export type VerifyWorkflowCaseAccess = (assertion: string | undefined, purpose: WorkflowCaseAccess['purpose']) => Promise<WorkflowCaseAccess>;

export function createWorkflowCaseAccessVerifier(options: Readonly<{ secret: string; issuer: string; audience: string; tenantId: string; environmentId: string; now?: () => Date }>): VerifyWorkflowCaseAccess {
  if (Buffer.byteLength(options.secret, 'utf8') < 32) throw new Error('Workflow assertion secret must contain at least 32 bytes');
  const key = new TextEncoder().encode(options.secret);
  const now = options.now ?? (() => new Date());
  return async (assertion, purpose) => {
    if (!assertion || assertion.length > 8_192) throw new Error('WORKFLOW_UNAUTHORIZED');
    try {
      const currentDate = now();
      const { payload } = await jwtVerify(assertion, key, { algorithms: ['HS256'], issuer: options.issuer, audience: options.audience, typ: 'cso-workflow+jwt', currentDate });
      const claims = claimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);
      if (claims.tenant.tenantId !== options.tenantId || claims.tenant.environmentId !== options.environmentId || claims.purpose !== purpose || claims.iat > nowSeconds + 30 || claims.exp <= nowSeconds || claims.exp - claims.iat > 60) throw new Error('WORKFLOW_UNAUTHORIZED');
      return { workflowId: claims.workflow.workflowId, tenantId: claims.tenant.tenantId, environmentId: claims.tenant.environmentId, subjectCustomerId: claims.subject.customerId, purpose: claims.purpose };
    } catch { throw new Error('WORKFLOW_UNAUTHORIZED'); }
  };
}
