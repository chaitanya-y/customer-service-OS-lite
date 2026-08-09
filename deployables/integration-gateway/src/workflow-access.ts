import { jwtVerify } from 'jose';
import { z } from 'zod';

import type { OrderAccessContext } from './trusted-context.js';

export const WORKFLOW_ACCESS_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const workflowAccessClaimsSchema = z
  .object({
    accessVersion: z.literal('1'),
    workflow: z
      .object({
        workflowId: opaqueId,
      })
      .strict(),
    tenant: z
      .object({
        tenantId: opaqueId,
        environmentId: opaqueId,
      })
      .strict(),
    subject: z
      .object({
        customerId: opaqueId,
      })
      .strict(),
    purpose: z.enum(['refund_fact_refresh', 'refund_execute', 'refund_reconcile']),
    request: z
      .object({
        requestId: opaqueId,
        traceId: opaqueId,
      })
      .strict(),
    iss: z.string().min(1).max(200),
    aud: z.string().min(1).max(200),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type VerifyWorkflowAccessAssertion = (
  assertion: string | undefined,
) => Promise<OrderAccessContext>;

type WorkflowAccessAssertionVerifierOptions = {
  secret: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  expectedPurpose?: 'refund_fact_refresh' | 'refund_execute' | 'refund_reconcile';
  now?: () => Date;
};

export function createHmacWorkflowAccessAssertionVerifier({
  secret,
  expectedIssuer,
  expectedAudience,
  expectedTenantId,
  expectedEnvironmentId,
  expectedPurpose = 'refund_fact_refresh',
  now = () => new Date(),
}: WorkflowAccessAssertionVerifierOptions): VerifyWorkflowAccessAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Workflow access assertion secret must contain at least 32 bytes');
  }

  const verificationKey = new TextEncoder().encode(secret);

  return async (assertion) => {
    if (!assertion || assertion.length > 8_192) {
      throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
    }

    try {
      const currentDate = now();
      const { payload } = await jwtVerify(assertion, verificationKey, {
        algorithms: ['HS256'],
        issuer: expectedIssuer,
        audience: expectedAudience,
        typ: 'cso-workflow+jwt',
        currentDate,
      });
      const claims = workflowAccessClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);

      if (
        claims.tenant.tenantId !== expectedTenantId ||
        claims.tenant.environmentId !== expectedEnvironmentId ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300
        || claims.purpose !== expectedPurpose
      ) {
        throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
      }

      return {
        contextId: claims.workflow.workflowId,
        tenantId: claims.tenant.tenantId,
        environmentId: claims.tenant.environmentId,
        subjectCustomerId: claims.subject.customerId,
        routingEpoch: 1,
        requestId: claims.request.requestId,
        traceId: claims.request.traceId,
      };
    } catch {
      throw new Error('WORKFLOW_ACCESS_UNAUTHORIZED');
    }
  };
}
