import { jwtVerify } from 'jose';
import { z } from 'zod';

export const CONTEXT_ASSERTION_HEADER = 'x-cso-context-assertion';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const trustedContextClaimsSchema = z
  .object({
    contextVersion: z.literal('1'),
    contextId: opaqueId,
    tenant: z
      .object({
        tenantId: opaqueId,
        environmentId: opaqueId,
      })
      .strict(),
    actor: z
      .object({
        kind: z.literal('end_customer'),
        principalId: opaqueId,
      })
      .strict(),
    subject: z
      .object({
        customerId: opaqueId,
      })
      .strict(),
    delegation: z
      .object({
        mode: z.literal('self'),
      })
      .strict(),
    purpose: z.literal('customer_support'),
    iss: z.string().min(1).max(200),
    aud: z.string().min(1).max(200),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    request: z
      .object({
        requestId: opaqueId,
        traceId: opaqueId,
        channelId: opaqueId,
      })
      .strict(),
  })
  .strict();

export type OrderAccessContext = {
  contextId: string;
  tenantId: string;
  environmentId: string;
  subjectCustomerId: string;
  requestId: string;
  traceId: string;
};

export type VerifyContextAssertion = (
  assertion: string | undefined,
) => Promise<OrderAccessContext>;

type ContextAssertionVerifierOptions = {
  secret: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  now?: () => Date;
};

export class ContextAssertionError extends Error {
  constructor() {
    super('Trusted context assertion is invalid');
    this.name = 'ContextAssertionError';
  }
}

export function createHmacContextAssertionVerifier({
  secret,
  expectedIssuer,
  expectedAudience,
  expectedTenantId,
  expectedEnvironmentId,
  now = () => new Date(),
}: ContextAssertionVerifierOptions): VerifyContextAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Context assertion secret must contain at least 32 bytes');
  }

  const verificationKey = new TextEncoder().encode(secret);

  return async (assertion) => {
    try {
      if (!assertion || assertion.length > 8_192) {
        throw new ContextAssertionError();
      }

      const currentDate = now();
      const { payload } = await jwtVerify(assertion, verificationKey, {
        algorithms: ['HS256'],
        issuer: expectedIssuer,
        audience: expectedAudience,
        typ: 'cso-context+jwt',
        currentDate,
      });
      const claims = trustedContextClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);

      if (
        claims.tenant.tenantId !== expectedTenantId ||
        claims.tenant.environmentId !== expectedEnvironmentId ||
        claims.actor.principalId !== claims.subject.customerId ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300
      ) {
        throw new ContextAssertionError();
      }

      return {
        contextId: claims.contextId,
        tenantId: claims.tenant.tenantId,
        environmentId: claims.tenant.environmentId,
        subjectCustomerId: claims.subject.customerId,
        requestId: claims.request.requestId,
        traceId: claims.request.traceId,
      };
    } catch (error) {
      if (error instanceof ContextAssertionError) {
        throw error;
      }

      throw new ContextAssertionError();
    }
  };
}
