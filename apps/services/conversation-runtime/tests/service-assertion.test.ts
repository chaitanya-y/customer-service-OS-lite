import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import {
  createHmacServiceAssertionVerifier,
  ServiceAssertionError,
} from '../src/service-assertion.js';

const SECRET = 'edge-service-assertion-secret-at-least-32-bytes';
const CUSTOMER_CONTEXT_SECRET =
  'customer-context-assertion-secret-at-least-32-bytes';
const NOW = new Date('2026-08-05T12:00:00.000Z');

async function createAssertion(
  overrides: Partial<{ purpose: string; audience: string }> = {},
) {
  const issuedAt = Math.floor(NOW.getTime() / 1_000);

  return new SignJWT({
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    requestId: 'request-1',
    traceId: 'trace-1',
    routingEpoch: 7,
    purpose: overrides.purpose ?? 'conversation_assistant_message',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'cso-service+jwt' })
    .setIssuer('customer-service-os-edge')
    .setAudience(overrides.audience ?? 'conversation-runtime')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .sign(new TextEncoder().encode(SECRET));
}

test('verifies an Edge-only assistant message assertion', async () => {
  const verify = createHmacServiceAssertionVerifier({
    secret: SECRET,
    expectedIssuer: 'customer-service-os-edge',
    expectedAudience: 'conversation-runtime',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => NOW,
  });

  assert.deepEqual(await verify(await createAssertion()), {
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    routingEpoch: 7,
    requestId: 'request-1',
    traceId: 'trace-1',
  });
});

test('rejects a customer context assertion signed with a separate key', async () => {
  const verify = createHmacServiceAssertionVerifier({
    secret: SECRET,
    expectedIssuer: 'customer-service-os-edge',
    expectedAudience: 'conversation-runtime',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => NOW,
  });

  const issuedAt = Math.floor(NOW.getTime() / 1_000);
  const customerAssertion = await new SignJWT({
    contextVersion: '1',
    contextId: 'context-1',
    tenant: { tenantId: 'tenant-local', environmentId: 'local' },
    actor: { kind: 'end_customer', principalId: 'customer-42' },
    subject: { customerId: 'customer-42' },
    delegation: { mode: 'self' },
    purpose: 'customer_support',
    route: {
      homeRegion: 'local',
      homeCell: 'local-cell-1',
      routingEpoch: 7,
    },
    request: {
      requestId: 'request-1',
      traceId: 'trace-1',
      channelId: 'web',
    },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'cso-context+jwt' })
    .setIssuer('customer-service-os-edge')
    .setAudience('conversation-runtime')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .sign(new TextEncoder().encode(CUSTOMER_CONTEXT_SECRET));

  await assert.rejects(
    () => verify(customerAssertion),
    ServiceAssertionError,
  );
});
