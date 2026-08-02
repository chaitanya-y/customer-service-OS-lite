import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import {
  type AuthenticatedCustomer,
  CustomerAuthenticationError,
  type VerifyCustomerIdentity,
} from './customer-identity.js';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const authenticatedCustomerSchema = z
  .object({
    principalId: opaqueId,
    tenantId: opaqueId,
    environmentId: opaqueId,
    customerId: opaqueId,
  })
  .strict();

const localCustomerClaimsSchema = z
  .object({
    iss: z.string().min(1).max(200),
    aud: z.string().min(1).max(200),
    sub: opaqueId,
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    tenantId: opaqueId,
    environmentId: opaqueId,
    customerId: opaqueId,
  })
  .strict();

type LocalCustomerIdentityVerifierOptions = {
  secret: string;
  expectedIssuer: string;
  expectedAudience: string;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  now?: () => Date;
};

type LocalCustomerTokenOptions = {
  secret: string;
  issuer: string;
  audience: string;
  identity: AuthenticatedCustomer;
  lifetimeSeconds?: number;
  now?: () => Date;
};

function createHmacKey(secret: string): Uint8Array {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Local authentication secret must contain at least 32 bytes');
  }

  return new TextEncoder().encode(secret);
}

export function createLocalCustomerIdentityVerifier({
  secret,
  expectedIssuer,
  expectedAudience,
  expectedTenantId,
  expectedEnvironmentId,
  now = () => new Date(),
}: LocalCustomerIdentityVerifierOptions): VerifyCustomerIdentity {
  const verificationKey = createHmacKey(secret);

  return async (accessToken) => {
    try {
      if (!accessToken || accessToken.length > 8_192) {
        throw new CustomerAuthenticationError();
      }

      const currentDate = now();
      const { payload } = await jwtVerify(accessToken, verificationKey, {
        algorithms: ['HS256'],
        issuer: expectedIssuer,

        audience: expectedAudience,
        typ: 'cso-local-customer+jwt',
        currentDate,
      });
      const claims = localCustomerClaimsSchema.parse(payload);
      const nowSeconds = Math.floor(currentDate.getTime() / 1_000);

      if (
        claims.tenantId !== expectedTenantId ||
        claims.environmentId !== expectedEnvironmentId ||
        claims.sub !== claims.customerId ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= nowSeconds ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 3_600
      ) {
        throw new CustomerAuthenticationError();
      }

      return {
        principalId: claims.sub,
        tenantId: claims.tenantId,
        environmentId: claims.environmentId,
        customerId: claims.customerId,
      };
    } catch (error) {
      if (error instanceof CustomerAuthenticationError) {
        throw error;
      }

      throw new CustomerAuthenticationError();
    }
  };
}

export async function signLocalCustomerAccessToken({
  secret,
  issuer,
  audience,
  identity: unvalidatedIdentity,
  lifetimeSeconds = 3_600,
  now = () => new Date(),
}: LocalCustomerTokenOptions): Promise<string> {
  const identity = authenticatedCustomerSchema.parse(unvalidatedIdentity);

  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 3_600) {
    throw new Error('Local customer token lifetime must be between 1 and 3600 seconds');
  }

  const signingKey = createHmacKey(secret);
  const issuedAt = Math.floor(now().getTime() / 1_000);

  return new SignJWT({
    tenantId: identity.tenantId,
    environmentId: identity.environmentId,
    customerId: identity.customerId,
  })
    .setProtectedHeader({
      alg: 'HS256',
      typ: 'cso-local-customer+jwt',
    })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(identity.principalId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
    .sign(signingKey);
}
