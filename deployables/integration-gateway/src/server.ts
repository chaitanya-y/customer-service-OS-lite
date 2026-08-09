import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createHmacContextAssertionVerifier } from './trusted-context.js';
import { createVendureCommerceProvider } from './vendure-client.js';
import { createHmacWorkflowAccessAssertionVerifier } from './workflow-access.js';

const config = loadConfig();
const commerceProvider = createVendureCommerceProvider({
  adminApiUrl: config.VENDURE_ADMIN_API_URL,
  apiKey: config.VENDURE_API_KEY,
});
const verifyContextAssertion = createHmacContextAssertionVerifier({
  secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
  expectedIssuer: config.CONTEXT_ASSERTION_ISSUER,
  expectedAudience: 'integration-gateway',
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const verifyWorkflowAccessAssertion = createHmacWorkflowAccessAssertionVerifier({
  secret: config.WORKFLOW_ACCESS_HMAC_SECRET,
  expectedIssuer: config.WORKFLOW_ACCESS_ISSUER,
  expectedAudience: 'integration-gateway',
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const app = buildApp({
  commerceProvider,
  verifyContextAssertion,
  verifyWorkflowAccessAssertion,
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
