import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SignJWT } from 'jose';

import { createHmacWorkflowAccessAssertionVerifier } from '../src/workflow-access.js';

const secret = 'test-only-workflow-secret-with-at-least-32-bytes';
const now = new Date('2026-08-08T12:00:00.000Z');

function createVerifier() {
  return createHmacWorkflowAccessAssertionVerifier({
    secret,
    expectedIssuer: 'customer-service-os-workflow-workers',
    expectedAudience: 'integration-gateway',
    expectedTenantId: 'tenant-local',
    expectedEnvironmentId: 'local',
    now: () => now,
  });
}

async function createAssertion({ tenantId = 'tenant-local' } = {}): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({
    accessVersion: '1',
    workflow: { workflowId: 'refund-workflow-001' },
    tenant: { tenantId, environmentId: 'local' },
    subject: { customerId: 'customer-42' },
    purpose: 'refund_fact_refresh',
    request: { requestId: 'request-001', traceId: 'trace-001' },
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'cso-workflow+jwt' })
    .setIssuer('customer-service-os-workflow-workers')
    .setAudience('integration-gateway')
    .setIssuedAt(Math.floor(now.getTime() / 1_000))
    .setExpirationTime(Math.floor(now.getTime() / 1_000) + 60)
    .sign(key);
}

test('verifies a short-lived Workflow Worker fact-refresh assertion', async () => {
  const context = await createVerifier()(await createAssertion());

  assert.deepEqual(context, {
    contextId: 'refund-workflow-001',
    tenantId: 'tenant-local',
    environmentId: 'local',
    subjectCustomerId: 'customer-42',
    routingEpoch: 1,
    requestId: 'request-001',
    traceId: 'trace-001',
  });
});

test('rejects a Workflow Worker assertion for another tenant', async () => {
  await assert.rejects(
    createVerifier()(await createAssertion({ tenantId: 'another-tenant' })),
    /WORKFLOW_ACCESS_UNAUTHORIZED/,
  );
});
