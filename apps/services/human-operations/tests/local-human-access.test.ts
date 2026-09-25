import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeJwt } from 'jose';

import { createHumanAssertionVerifier } from '../src/human-access.js';
import { signLocalHumanAccessAssertion } from '../src/local-human-access.js';

function generateCliToken(ttl?: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'src/local-token-cli.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      HUMAN_ACCESS_HMAC_SECRET: 'a-local-human-access-secret-that-is-long-enough',
      TENANT_ID: 'tenant-local',
      ENVIRONMENT_ID: 'local',
      ...(ttl === undefined ? {} : { LOCAL_HUMAN_ACCESS_TTL_SECONDS: ttl }),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('local staff CLI defaults to thirty days and preserves the staff identity', async () => {
  const assertion = generateCliToken();
  const access = await createHumanAssertionVerifier({
    secret: 'a-local-human-access-secret-that-is-long-enough',
    issuer: 'customer-service-os-human-operations',
    audience: 'human-operations',
    tenantId: 'tenant-local',
    environmentId: 'local',
  })(assertion);

  assert.equal(access.staffId, 'local-refund-supervisor');
  assert.equal(access.role, 'REFUND_SUPERVISOR');
  assert.equal(access.exp! - access.iat!, 2_592_000);
});

test('local staff CLI accepts thirty days and refuses a longer configured lifetime', () => {
  const claims = decodeJwt(generateCliToken('2592000'));
  assert.equal(claims.exp! - claims.iat!, 2_592_000);
  assert.throws(() => generateCliToken('2592001'), /LOCAL_HUMAN_ACCESS_TTL_SECONDS/);
});

test('creates an assertion accepted by Human Operations', async () => {
  const secret = 'a-local-human-access-secret-that-is-long-enough';
  const assertion = await signLocalHumanAccessAssertion({
    secret,
    issuer: 'customer-service-os-human-operations',
    audience: 'human-operations',
    identity: {
      staffId: 'local-refund-supervisor',
      tenantId: 'tenant-local',
      environmentId: 'local',
      role: 'REFUND_SUPERVISOR',
    },
  });

  const access = await createHumanAssertionVerifier({
    secret,
    issuer: 'customer-service-os-human-operations',
    audience: 'human-operations',
    tenantId: 'tenant-local',
    environmentId: 'local',
  })(assertion);

  assert.equal(access.staffId, 'local-refund-supervisor');
  assert.equal(access.role, 'REFUND_SUPERVISOR');
});
