// Synthetic ESM integration fixture: real Edge routing/auth/client, no Temporal or commerce.
import assert from 'node:assert/strict';
import { initializeTelemetry } from '../../packages/observability-node/index.mjs';
import { buildApp } from '../../apps/services/edge-api/src/app.js';
import { createAgentRuntimeClient } from '../../apps/services/edge-api/src/agent-runtime-client.js';
import { createHmacContextAssertionSigner } from '../../apps/services/edge-api/src/context-assertion.js';
import { createLocalCustomerIdentityVerifier, signLocalCustomerAccessToken } from '../../apps/services/edge-api/src/local-customer-auth.js';

const telemetry = initializeTelemetry({ serviceName: 'edge-api', enabled: true });
const identity = { principalId: 'smoke-customer', customerId: 'smoke-customer', tenantId: 'smoke-tenant', environmentId: 'local' };
const loginSecret = 'synthetic-login-key-not-for-real-use-0000';
const assertionSecret = 'synthetic-context-key-not-for-real-use-00';
const signer = (audience: string) => createHmacContextAssertionSigner({
  secret: assertionSecret, issuer: 'smoke-edge', audience,
  route: { homeRegion: 'local', homeCell: 'local', routingEpoch: 1 },
});
const client = createAgentRuntimeClient({ baseUrl: process.env.SMOKE_AGENT_URL!, telemetry });
const app = buildApp({
  telemetry,
  verifyCustomerIdentity: createLocalCustomerIdentityVerifier({
    secret: loginSecret, expectedIssuer: 'smoke-login', expectedAudience: 'smoke-edge',
    expectedTenantId: identity.tenantId, expectedEnvironmentId: identity.environmentId,
  }),
  signContextAssertion: signer('integration-gateway'),
  signAgentRuntimeContextAssertion: signer('agent-runtime'),
  signKnowledgeRagContextAssertion: signer('knowledge-rag'),
  intakeRefund: client.intakeRefund,
  startRefundWorkflow: async () => { throw new Error('Unexpected workflow in read-only smoke'); },
});

try {
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const token = await signLocalCustomerAccessToken({ secret: loginSecret, issuer: 'smoke-login', audience: 'smoke-edge', identity });
  const start = performance.now();
  const response = await fetch(`${address}/v1/refunds/intake?private=CANARY_CONTENT`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      baggage: 'private=CANARY_CONTENT',
    },
    body: JSON.stringify({ customer_message: 'I need a refund. CANARY_CONTENT' }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'awaiting_order_reference');
  const unauthorized = await fetch(`${address}/v1/refunds/intake`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customer_message: 'CANARY_CONTENT' }),
  });
  assert.equal(unauthorized.status, 401);
  console.log(JSON.stringify({ success: true, elapsed_ms: Math.round(performance.now() - start), auth_rejection: unauthorized.status }));
} finally {
  await app.close();
  await telemetry.shutdown();
}
