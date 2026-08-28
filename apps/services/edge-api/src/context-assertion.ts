import { randomUUID } from 'node:crypto';

import { SignJWT } from 'jose';
import { z } from 'zod';

import type { AuthenticatedCustomer } from './customer-identity.js';

export const CONTEXT_ASSERTION_HEADER = 'x-cso-context-assertion';
export const AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER =
  'x-cso-agent-context-assertion';
export const KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER =
  'x-cso-knowledge-context-assertion';
export const SERVICE_ASSERTION_HEADER = 'x-cso-service-assertion';

const opaqueId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const contextAssertionInputSchema = z
  .object({
    identity: z
      .object({
        principalId: opaqueId,
        tenantId: opaqueId,
        environmentId: opaqueId,
        customerId: opaqueId,
      })
      .strict(),
    requestId: opaqueId,
    traceId: opaqueId,
    channelId: opaqueId,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.identity.principalId !== input.identity.customerId) {
      context.addIssue({
        code: 'custom',
        message: 'Self-service principal must match the subject customer',
        path: ['identity', 'principalId'],
      });
    }
  });

export type ContextAssertionInput = {
  identity: AuthenticatedCustomer;
  requestId: string;
  traceId: string;
  channelId: string;
};

export type SignContextAssertion = (
  input: ContextAssertionInput,
) => Promise<string>;

export type ServiceAssertionInput = {
  identity: AuthenticatedCustomer;
  requestId: string;
  traceId: string;
};

export type SignServiceAssertion = (
  input: ServiceAssertionInput,
) => Promise<string>;

type ContextAssertionSignerOptions = {
  secret: string;
  issuer: string;
  audience: string;
  route: {
    homeRegion: string;
    homeCell: string;
    routingEpoch: number;
  };
  lifetimeSeconds?: number;
  now?: () => Date;
  createContextId?: () => string;
};

type ServiceAssertionSignerOptions = {
  secret: string;
  issuer: string;
  audience: string;
  routingEpoch: number;
  lifetimeSeconds?: number;
  now?: () => Date;
};

export function createHmacContextAssertionSigner({
  secret,
  issuer,
  audience,
  route,
  lifetimeSeconds = 60,
  now = () => new Date(),
  createContextId = randomUUID,
}: ContextAssertionSignerOptions): SignContextAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Context assertion secret must contain at least 32 bytes');
  }

  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > 300
  ) {
    throw new Error('Context assertion lifetime must be between 1 and 300 seconds');
  }

  const parsedRoute = z
    .object({
      homeRegion: opaqueId,
      homeCell: opaqueId,
      routingEpoch: z.number().int().min(1),
    })
    .strict()
    .parse(route);

  const signingKey = new TextEncoder().encode(secret);

  return async (unvalidatedInput) => {
    const input = contextAssertionInputSchema.parse(unvalidatedInput);
    const issuedAt = Math.floor(now().getTime() / 1_000);

    return new SignJWT({
      contextVersion: '1',
      contextId: createContextId(),
      tenant: {
        tenantId: input.identity.tenantId,
        environmentId: input.identity.environmentId,
      },
      actor: {
        kind: 'end_customer',
        principalId: input.identity.principalId,
      },
      subject: {
        customerId: input.identity.customerId,
      },
      delegation: {
        mode: 'self',
      },
      purpose: 'customer_support',
      route: parsedRoute,
      request: {
        requestId: input.requestId,
        traceId: input.traceId,
        channelId: input.channelId,
      },
    })
      .setProtectedHeader({
        alg: 'HS256',
        typ: 'cso-context+jwt',
      })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(signingKey);
  };
}

export function createHmacServiceAssertionSigner({
  secret,
  issuer,
  audience,
  routingEpoch,
  lifetimeSeconds = 60,
  now = () => new Date(),
}: ServiceAssertionSignerOptions): SignServiceAssertion {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Service assertion secret must contain at least 32 bytes');
  }

  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > 300
  ) {
    throw new Error('Service assertion lifetime must be between 1 and 300 seconds');
  }

  const parsedRoutingEpoch = z.number().int().min(1).parse(routingEpoch);
  const signingKey = new TextEncoder().encode(secret);

  return async (unvalidatedInput) => {
    const input = contextAssertionInputSchema.parse({
      ...unvalidatedInput,
      channelId: 'internal',
    });
    const issuedAt = Math.floor(now().getTime() / 1_000);

    return new SignJWT({
      tenantId: input.identity.tenantId,
      environmentId: input.identity.environmentId,
      subjectCustomerId: input.identity.customerId,
      requestId: input.requestId,
      traceId: input.traceId,
      routingEpoch: parsedRoutingEpoch,
      purpose: 'conversation_assistant_message',
    })
      .setProtectedHeader({
        alg: 'HS256',
        typ: 'cso-service+jwt',
      })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + lifetimeSeconds)
      .sign(signingKey);
  };
}
