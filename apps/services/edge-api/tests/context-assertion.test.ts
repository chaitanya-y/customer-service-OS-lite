import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeProtectedHeader, jwtVerify } from 'jose';

import { createHmacContextAssertionVerifier } from '../../integration-gateway/src/trusted-context.js';
import {
  createHmacContextAssertionSigner,
  createHmacServiceAssertionSigner,
} from '../src/context-assertion.js';

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
    route: {
      homeRegion: 'local',
      homeCell: 'local-cell-1',
      routingEpoch: 1,
    },
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
    routingEpoch: 1,
    requestId: 'request-1',
    traceId: 'trace-1',
  });
});

test('refuses to create a self-service assertion for another customer', async () => {
  const sign = createHmacContextAssertionSigner({
    secret: TEST_SECRET,
    issuer: 'edge-api',
    audience: 'integration-gateway',
    route: {
      homeRegion: 'local',
      homeCell: 'local-cell-1',
      routingEpoch: 1,
    },
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
        route: {
          homeRegion: 'local',
          homeCell: 'local-cell-1',
          routingEpoch: 1,
        },
        lifetimeSeconds: 301,
      }),
    /Context assertion lifetime must be between 1 and 300 seconds/,
  );
});

test('keeps the Conversation Runtime customer context audience separate', async () => {
  const sign = createHmacContextAssertionSigner({
    secret: TEST_SECRET,
    issuer: 'edge-api',
    audience: 'conversation-runtime',
    route: {
      homeRegion: 'local',
      homeCell: 'local-cell-1',
      routingEpoch: 1,
    },
    now: () => TEST_NOW,
    createContextId: () => 'context-1',
  });

  const assertion = await sign({
    identity: TEST_IDENTITY,
    requestId: 'request-1',
    traceId: 'trace-1',
    channelId: 'web',
  });

  await jwtVerify(assertion, new TextEncoder().encode(TEST_SECRET), {
    algorithms: ['HS256'],
    issuer: 'edge-api',
    audience: 'conversation-runtime',
    currentDate: TEST_NOW,
    typ: 'cso-context+jwt',
  });
  await assert.rejects(
    () =>
      jwtVerify(assertion, new TextEncoder().encode(TEST_SECRET), {
        algorithms: ['HS256'],
        issuer: 'edge-api',
        audience: 'agent-runtime',
        currentDate: TEST_NOW,
        typ: 'cso-context+jwt',
      }),
  );
});

test('creates a separately keyed Edge service assertion for assistant writes', async () => {
  const serviceSecret = 'edge-service-assertion-secret-at-least-32-bytes';
  const sign = createHmacServiceAssertionSigner({
    secret: serviceSecret,
    issuer: 'customer-service-os-edge',
    audience: 'conversation-runtime',
    routingEpoch: 1,
    now: () => TEST_NOW,
  });

  const assertion = await sign({
    identity: TEST_IDENTITY,
    requestId: 'request-1',
    traceId: 'trace-1',
  });
  const { payload } = await jwtVerify(
    assertion,
    new TextEncoder().encode(serviceSecret),
    {
      algorithms: ['HS256'],
      issuer: 'customer-service-os-edge',
      audience: 'conversation-runtime',
      currentDate: TEST_NOW,
      typ: 'cso-service+jwt',
    },
  );

  assert.deepEqual(decodeProtectedHeader(assertion), {
    alg: 'HS256',
    typ: 'cso-service+jwt',
  });
  assert.deepEqual(payload, {
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    requestId: 'request-1',
    traceId: 'trace-1',
    routingEpoch: 1,
    purpose: 'conversation_assistant_message',
    iss: 'customer-service-os-edge',
    aud: 'conversation-runtime',
    iat: 1767268800,
    exp: 1767268860,
  });
  await assert.rejects(
    () =>
      jwtVerify(assertion, new TextEncoder().encode(TEST_SECRET), {
        algorithms: ['HS256'],
        issuer: 'customer-service-os-edge',
        audience: 'conversation-runtime',
        currentDate: TEST_NOW,
        typ: 'cso-service+jwt',
      }),
  );
});
