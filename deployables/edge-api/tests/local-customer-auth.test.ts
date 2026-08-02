import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CustomerAuthenticationError } from '../src/customer-identity.js';
import {
  createLocalCustomerIdentityVerifier,
  signLocalCustomerAccessToken,
} from '../src/local-customer-auth.js';

const TEST_NOW = new Date('2026-01-01T12:00:00.000Z');
const TEST_SECRET = 'local-auth-secret-at-least-32-bytes';
const TEST_IDENTITY = {
  principalId: 'customer-42',
  tenantId: 'tenant-local',
  environmentId: 'local',
  customerId: 'customer-42',
};

function createVerifier(now = TEST_NOW) {
  return createLocalCustomerIdentityVerifier({
    secret: TEST_SECRET,
    expectedIssuer: 'local-auth',
    expectedAudience: 'edge-api',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => now,
  });
}

async function createToken(
  overrides: Partial<typeof TEST_IDENTITY> = {},
  lifetimeSeconds = 3_600,
) {
  return signLocalCustomerAccessToken({
    secret: TEST_SECRET,
    issuer: 'local-auth',
    audience: 'edge-api',
    identity: { ...TEST_IDENTITY, ...overrides },
    lifetimeSeconds,
    now: () => TEST_NOW,
  });
}

test('verifies a valid local customer access token', async () => {
  assert.deepEqual(await createVerifier()(await createToken()), TEST_IDENTITY);
});

test('rejects a token for another tenant', async () => {
  const token = await createToken({ tenantId: 'tenant-other' });

  await assert.rejects(
    () => createVerifier()(token),
    CustomerAuthenticationError,
  );
});

test('rejects a tampered token', async () => {
  const token = await createToken();
  const [header, claims, signature] = token.split('.');
  assert.ok(header && claims && signature);
  const tamperedSignature = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

  await assert.rejects(
    () => createVerifier()(`${header}.${claims}.${tamperedSignature}`),
    CustomerAuthenticationError,
  );
});

test('rejects an expired token', async () => {
  const token = await createToken({}, 1);
  const verifier = createVerifier(new Date(TEST_NOW.getTime() + 2_000));

  await assert.rejects(() => verifier(token), CustomerAuthenticationError);
});

test('rejects a missing token', async () => {
  await assert.rejects(
    () => createVerifier()(undefined),
    CustomerAuthenticationError,
  );
});
