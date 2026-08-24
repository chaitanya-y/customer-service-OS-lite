import { createHmac } from 'node:crypto';

import {
  createHmacContextAssertionVerifier,
  type OrderAccessContext,
} from '../src/trusted-context.js';

export const TEST_CONTEXT_SECRET =
  'test-only-context-secret-with-at-least-32-bytes';
export const TEST_TENANT_ID = 'tenant-local';
export const TEST_ENVIRONMENT_ID = 'local';
export const TEST_CONTEXT_ISSUER = 'customer-service-os-edge';
export const TEST_CONTEXT_AUDIENCE = 'integration-gateway';
export const TEST_NOW = new Date('2026-07-26T12:00:00.000Z');

type TestAssertionOptions = {
  secret?: string;
  tenantId?: string;
  environmentId?: string;
  customerId?: string;
  actorPrincipalId?: string;
  issuer?: string;
  audience?: string;
  tokenType?: string;
  issuedAt?: number;
  expiresAt?: number;
};

export function createTestContextAssertion(
  options: TestAssertionOptions = {},
): string {
  const nowSeconds = Math.floor(TEST_NOW.getTime() / 1_000);
  const header = Buffer.from(
    JSON.stringify({
      alg: 'HS256',
      typ: options.tokenType ?? 'cso-context+jwt',
    }),
  ).toString('base64url');
  const customerId = options.customerId ?? 'customer-42';
  const claims = Buffer.from(
    JSON.stringify({
      contextVersion: '1',
      contextId: 'context-1',
      tenant: {
        tenantId: options.tenantId ?? TEST_TENANT_ID,
        environmentId: options.environmentId ?? TEST_ENVIRONMENT_ID,
      },
      actor: {
        kind: 'end_customer',
        principalId: options.actorPrincipalId ?? customerId,
      },
      subject: {
        customerId,
      },
      delegation: {
        mode: 'self',
      },
      purpose: 'customer_support',
      route: {
        homeRegion: 'local',
        homeCell: 'local-cell-1',
        routingEpoch: 1,
      },
      iss: options.issuer ?? TEST_CONTEXT_ISSUER,
      aud: options.audience ?? TEST_CONTEXT_AUDIENCE,
      iat: options.issuedAt ?? nowSeconds,
      exp: options.expiresAt ?? nowSeconds + 300,
      request: {
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      },
    }),
  ).toString('base64url');
  const signature = createHmac(
    'sha256',
    options.secret ?? TEST_CONTEXT_SECRET,
  )
    .update(`${header}.${claims}`)
    .digest('base64url');

  return `${header}.${claims}.${signature}`;
}

export const TEST_CONTEXT_ASSERTION = createTestContextAssertion();

export const TEST_ACCESS_CONTEXT: OrderAccessContext = {
  contextId: 'context-1',
  tenantId: TEST_TENANT_ID,
  environmentId: TEST_ENVIRONMENT_ID,
  subjectCustomerId: 'customer-42',
  routingEpoch: 1,
  requestId: 'request-1',
  traceId: 'trace-1',
};

export const verifyTestContextAssertion =
  createHmacContextAssertionVerifier({
    secret: TEST_CONTEXT_SECRET,
    expectedIssuer: TEST_CONTEXT_ISSUER,
    expectedAudience: TEST_CONTEXT_AUDIENCE,
    expectedTenantId: TEST_TENANT_ID,
    expectedEnvironmentId: TEST_ENVIRONMENT_ID,
    now: () => TEST_NOW,
  });
