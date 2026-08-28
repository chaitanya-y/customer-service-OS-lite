import { jwtVerify } from 'jose';
import { z } from 'zod';

export const SERVICE_ASSERTION_HEADER = 'x-cso-service-assertion';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const serviceAssertionClaimsSchema = z
  .object({
    tenantId: opaqueId,
    environmentId: opaqueId,
    subjectCustomerId: opaqueId,
    requestId: opaqueId,
    traceId: opaqueId,
    routingEpoch: z.number().int().min(1),
    purpose: z.literal('conversation_assistant_message'),
    iss: z.string().min(1).max(200),
    aud: z.string().min(1).max(200),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type ConversationServiceAccessContext = {
  tenantId: string;
  environmentId: string;
  subjectCustomerId: string;
  routingEpoch: number;
  requestId: string;
  traceId: string;
};

export type VerifyServiceAssertion = (
  assertion: string | undefined,
) => Promise<ConversationServiceAccessContext>;

type ServiceAssertionVerifierOptions = {
  secret: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  now?: () => Date;
};

export class ServiceAssertionError extends Error {
  constructor() {
    super('Service assertion is invalid');
    this.name = 'ServiceAssertionError';
  }
}

export function createHmacServiceAssertionVerifier({
  secret,
  expectedIssuer,
  expectedAudience,
  expectedTenantId,
  expectedEnvironmentId,
  now = () => new Date(),
}: ServiceAssertionVerifierOptions): VerifyServiceAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Service assertion secret must contain at least 32 bytes');
  }

  const verificationKey = new TextEncoder().encode(secret);

  return async (assertion) => {
    try {
      if (!assertion || assertion.length > 8_192) {
        throw new ServiceAssertionError();
      }

      const currentDate = now();
      const { payload } = await jwtVerify(assertion, verificationKey, {
        algorithms: ['HS256'],
        issuer: expectedIssuer,
        audience: expectedAudience,
        typ: 'cso-service+jwt',
        currentDate,
      });
      const claims = serviceAssertionClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);

      if (
        claims.tenantId !== expectedTenantId ||
        claims.environmentId !== expectedEnvironmentId ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 300
      ) {
        throw new ServiceAssertionError();
      }

      return {
        tenantId: claims.tenantId,
        environmentId: claims.environmentId,
        subjectCustomerId: claims.subjectCustomerId,
        routingEpoch: claims.routingEpoch,
        requestId: claims.requestId,
        traceId: claims.traceId,
      };
    } catch (error) {
      if (error instanceof ServiceAssertionError) {
        throw error;
      }

      throw new ServiceAssertionError();
    }
  };
}
