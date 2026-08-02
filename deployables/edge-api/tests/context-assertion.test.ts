import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHmacContextAssertionVerifier } from '../../integration-gateway/src/trusted-context.js';
import { createHmacContextAssertionSigner } from '../src/context-assertion.js';

const TEST_NOW = new Date('2026-01-01T12:00:00.000Z');
const TEST_SECRET = 'context-assertion-secret-at-least-32-bytes';
const TEST_IDENTITY = {
  principalId: 'customer-42',
  tenantId: 'tenant-local',
  environmentId: 'local',
  customerId: 'customer-42',
};

test('creates an assertion accepted by the Integration Gateway', async () => {
  const sign = createHmacContextAssertionSigner({
    secret: TEST_SECRET,
    issuer: 'edge-api',
    audience: 'integration-gateway',
    now: () => TEST_NOW,
    createContextId: () => 'context-1',
  });
  const verify = createHmacContextAssertionVerifier({
    secret: TEST_SECRET,
    expectedIssuer: 'edge-api',
    expectedAudience: 'integration-gateway',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => TEST_NOW,
  });

  const context = await verify(
    await sign({
      identity: TEST_IDENTITY,
      requestId: 'request-1',
      traceId: 'trace-1',
      channelId: 'web',
    }),
  );

  assert.deepEqual(context, {
    contextId: 'context-1',
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    requestId: 'request-1',
    traceId: 'trace-1',
  });
});

test('refuses to create a self-service assertion for another customer', async () => {
  const sign = createHmacContextAssertionSigner({
    secret: TEST_SECRET,
    issuer: 'edge-api',
    audience: 'integration-gateway',
    now: () => TEST_NOW,
  });

  await assert.rejects(
    () =>
      sign({
        identity: { ...TEST_IDENTITY, principalId: 'customer-other' },
        requestId: 'request-1',
        traceId: 'trace-1',
        channelId: 'web',
      }),
    /Self-service principal must match the subject customer/,
  );
});

test('rejects a context assertion lifetime above five minutes', () => {
  assert.throws(
    () =>
      createHmacContextAssertionSigner({
        secret: TEST_SECRET,
        issuer: 'edge-api',
        audience: 'integration-gateway',
        lifetimeSeconds: 301,
      }),
    /Context assertion lifetime must be between 1 and 300 seconds/,
  );
});
