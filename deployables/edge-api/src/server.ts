import { createAgentRuntimeClient } from './agent-runtime-client.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createHmacContextAssertionSigner } from './context-assertion.js';
import { createLocalCustomerIdentityVerifier } from './local-customer-auth.js';

const config = loadConfig();
const verifyCustomerIdentity = createLocalCustomerIdentityVerifier({
  secret: config.LOCAL_AUTH_HMAC_SECRET,
  expectedIssuer: config.LOCAL_AUTH_ISSUER,
  expectedAudience: config.LOCAL_AUTH_AUDIENCE,
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const signContextAssertion = createHmacContextAssertionSigner({
  secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
  issuer: config.CONTEXT_ASSERTION_ISSUER,
  audience: config.CONTEXT_ASSERTION_AUDIENCE,
});
const agentRuntimeClient = createAgentRuntimeClient({
  baseUrl: config.AGENT_RUNTIME_BASE_URL,
});
const app = buildApp({
  verifyCustomerIdentity,
  signContextAssertion,
  intakeRefund: agentRuntimeClient.intakeRefund,
  logger: true,
});

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
