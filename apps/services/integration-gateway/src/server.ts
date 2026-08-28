import { buildApp } from './app.js';
import { Connection, WorkflowClient } from '@temporalio/client';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createHmacContextAssertionVerifier } from './trusted-context.js';
import { createVendureCommerceProvider } from './vendure-client.js';
import { createHmacWorkflowAccessAssertionVerifier } from './workflow-access.js';
import { PostgresRefundExecutionRepository } from './refund-execution-repository.js';
import { createHmacProviderRefundEventVerifier } from './provider-refund-event-routes.js';
import { createTemporalProviderRefundOutcomeSignaler } from './temporal-provider-refund-events.js';

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
const providerWebhookVerifier = config.PROVIDER_WEBHOOK_HMAC_SECRET === undefined
  ? undefined
  : createHmacProviderRefundEventVerifier(config.PROVIDER_WEBHOOK_HMAC_SECRET);
const temporalConnection = config.PROVIDER_WEBHOOK_HMAC_SECRET === undefined
  ? undefined
  : await Connection.connect({ address: config.TEMPORAL_ADDRESS });
const signalProviderRefundOutcome = temporalConnection === undefined
  ? undefined
  : createTemporalProviderRefundOutcomeSignaler(new WorkflowClient({ connection: temporalConnection }));
const app = buildApp({
  commerceProvider,
  verifyContextAssertion,
  verifyWorkflowAccessAssertion,
  verifyWorkflowRefundExecutionAssertion,
  verifyWorkflowRefundReconciliationAssertion,
  ...(providerWebhookVerifier === undefined
    ? {}
    : { verifyProviderRefundEventSignature: providerWebhookVerifier }),
  refundExecutionRepository,
  logger: true,
});

let isDispatchingProviderEvents = false;
async function dispatchPendingProviderEvents(): Promise<void> {
  if (!signalProviderRefundOutcome || isDispatchingProviderEvents) return;
  isDispatchingProviderEvents = true;
  try {
    for (const event of await refundExecutionRepository.listPendingProviderRefundEvents(100)) {
      try {
        await signalProviderRefundOutcome(event);
        await refundExecutionRepository.markProviderRefundEventDelivered(event.eventId);
      } catch (error) {
        app.log.warn({ err: error, eventId: event.eventId, workflowId: event.workflowId }, 'Provider refund event delivery deferred');
      }
    }
  } finally {
    isDispatchingProviderEvents = false;
  }
}

const providerEventDispatchInterval = setInterval(() => {
  void dispatchPendingProviderEvents();
}, 5_000);

try {
  await app.listen({
    host: config.HOST,
    port: config.PORT,
  });
} catch (error) {
  app.log.error(error);
  clearInterval(providerEventDispatchInterval);
  await temporalConnection?.close();
  await pool.end();
  process.exit(1);
}

async function shutdown() { clearInterval(providerEventDispatchInterval); await app.close(); await temporalConnection?.close(); await pool.end(); }
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
