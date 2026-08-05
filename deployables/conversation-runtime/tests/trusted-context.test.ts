import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import {
  ContextAssertionError,
  createHmacContextAssertionVerifier,
} from '../src/trusted-context.js';

const SECRET = 'context-assertion-secret-at-least-32-bytes';
const NOW = new Date('2026-08-05T12:00:00.000Z');

async function createAssertion(audience = 'conversation-runtime') {
  const issuedAt = Math.floor(NOW.getTime() / 1_000);

  return new SignJWT({
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
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .sign(new TextEncoder().encode(SECRET));
}

test('verifies tenant, customer, correlation, and routing epoch', async () => {
  const verify = createHmacContextAssertionVerifier({
    secret: SECRET,
    expectedIssuer: 'customer-service-os-edge',
    expectedAudience: 'conversation-runtime',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => NOW,
  });

  assert.deepEqual(await verify(await createAssertion()), {
    contextId: 'context-1',
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    routingEpoch: 7,
    requestId: 'request-1',
    traceId: 'trace-1',
  });
});

test('rejects an assertion intended for another service', async () => {
  const verify = createHmacContextAssertionVerifier({
    secret: SECRET,
    expectedIssuer: 'customer-service-os-edge',
    expectedAudience: 'conversation-runtime',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => NOW,
  });

  await assert.rejects(
    () => verify(createAssertion('integration-gateway')),
    ContextAssertionError,
  );
});
