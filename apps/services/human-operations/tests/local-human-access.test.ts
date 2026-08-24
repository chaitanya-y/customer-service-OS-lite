import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createHumanAssertionVerifier } from '../src/human-access.js';
import { signLocalHumanAccessAssertion } from '../src/local-human-access.js';

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
