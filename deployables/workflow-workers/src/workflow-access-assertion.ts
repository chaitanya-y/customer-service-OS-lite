import { SignJWT } from 'jose';
import { z } from 'zod';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const workflowJourneyAccessSchema = z
  .object({
    tenantId: opaqueId,
    environmentId: opaqueId,
    subjectCustomerId: opaqueId,
    requestId: opaqueId,
    traceId: opaqueId,
  })
  .strict();

export type WorkflowJourneyAccess = z.infer<typeof workflowJourneyAccessSchema>;

export type WorkflowAccessAssertionInput = Readonly<{
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type SignWorkflowAccessAssertion = (
  input: WorkflowAccessAssertionInput,
) => Promise<string>;

type WorkflowAccessAssertionSignerOptions = Readonly<{
  secret: string;
  issuer: string;
  audience: string;
  lifetimeSeconds?: number;
  now?: () => Date;
}>;

export function createHmacWorkflowAccessAssertionSigner({
  secret,
  issuer,
  audience,
  lifetimeSeconds = 60,
  now = () => new Date(),
}: WorkflowAccessAssertionSignerOptions): SignWorkflowAccessAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Workflow access assertion secret must contain at least 32 bytes');
  }
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) {
    throw new Error('Workflow access assertion lifetime must be between 1 and 300 seconds');
  }

  const signingKey = new TextEncoder().encode(secret);

  return async (unvalidatedInput) => {
    const access = workflowJourneyAccessSchema.parse(unvalidatedInput.access);
    const workflowId = opaqueId.parse(unvalidatedInput.workflowId);
    const issuedAt = Math.floor(now().getTime() / 1_000);

    return new SignJWT({
      accessVersion: '1',
      workflow: { workflowId },
      tenant: {
        tenantId: access.tenantId,
        environmentId: access.environmentId,
      },
      subject: { customerId: access.subjectCustomerId },
      purpose: 'refund_fact_refresh',
      request: { requestId: access.requestId, traceId: access.traceId },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(signingKey);
  };
}
