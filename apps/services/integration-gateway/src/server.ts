import { buildApp } from './app.js';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createHmacContextAssertionVerifier } from './trusted-context.js';
import { createVendureCommerceProvider } from './vendure-client.js';
import { createHmacWorkflowAccessAssertionVerifier } from './workflow-access.js';
import { PostgresRefundExecutionRepository } from './refund-execution-repository.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const refundExecutionRepository = new PostgresRefundExecutionRepository(pool);
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
const verifyWorkflowRefundExecutionAssertion = createHmacWorkflowAccessAssertionVerifier({
  secret: config.WORKFLOW_ACCESS_HMAC_SECRET,
  expectedIssuer: config.WORKFLOW_ACCESS_ISSUER,
  expectedAudience: 'integration-gateway',
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
  expectedPurpose: 'refund_execute',
});
const verifyWorkflowRefundReconciliationAssertion = createHmacWorkflowAccessAssertionVerifier({
  secret: config.WORKFLOW_ACCESS_HMAC_SECRET, expectedIssuer: config.WORKFLOW_ACCESS_ISSUER, expectedAudience: 'integration-gateway', expectedTenantId: config.TENANT_ID, expectedEnvironmentId: config.ENVIRONMENT_ID, expectedPurpose: 'refund_reconcile',
});
const app = buildApp({
  commerceProvider,
  verifyContextAssertion,
  verifyWorkflowAccessAssertion,
  verifyWorkflowRefundExecutionAssertion,
  verifyWorkflowRefundReconciliationAssertion,
  refundExecutionRepository,
  logger: true,
});

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exit(1);
}

async function shutdown() { await app.close(); await pool.end(); }
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
