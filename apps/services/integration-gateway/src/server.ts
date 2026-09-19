import { buildApp } from './app.js';
import { Connection, WorkflowClient } from '@temporalio/client';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createHmacContextAssertionVerifier } from './trusted-context.js';
import { createVendureCommerceProvider } from './vendure-client.js';
import { createHmacWorkflowAccessAssertionVerifier } from './workflow-access.js';
import { PostgresRefundExecutionRepository } from './refund-execution-repository.js';
import { createRefundOperationsObserver } from './refund-operations-observer.js';
import { createHmacProviderRefundEventVerifier } from './provider-refund-event-routes.js';
import { createTemporalProviderRefundOutcomeSignaler } from './temporal-provider-refund-events.js';
import type { TelemetryHandle } from '@cso/observability-node';
import { runWithin } from './observability.js';

export async function startServer({ telemetry }: { telemetry: TelemetryHandle }) {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  let temporalConnection: Connection | undefined;
  let providerEventDispatchInterval: NodeJS.Timeout | undefined;
  let refundOperationsObserver: ReturnType<typeof createRefundOperationsObserver> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let stopping = false;

  const close = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (providerEventDispatchInterval) clearInterval(providerEventDispatchInterval);
    refundOperationsObserver?.stop();
    await runWithin(() => app?.close(), 2_000, () => app?.server.closeAllConnections?.());
    await runWithin(() => temporalConnection?.close(), 2_000);
    await runWithin(() => pool.end(), 2_000);
  };

  try {
    const refundExecutionRepository = new PostgresRefundExecutionRepository(pool);
    refundOperationsObserver = createRefundOperationsObserver({
      repository: refundExecutionRepository,
      telemetry,
    });
    const commerceProvider = createVendureCommerceProvider({
      adminApiUrl: config.VENDURE_ADMIN_API_URL,
      apiKey: config.VENDURE_API_KEY,
      telemetry,
    });
    const verifyContextAssertion = createHmacContextAssertionVerifier({
      secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
      expectedIssuer: config.CONTEXT_ASSERTION_ISSUER,
      expectedAudience: 'integration-gateway',
      expectedTenantId: config.TENANT_ID,
      expectedEnvironmentId: config.ENVIRONMENT_ID,
    });
    const workflowVerifierOptions = {
      secret: config.WORKFLOW_ACCESS_HMAC_SECRET,
      expectedIssuer: config.WORKFLOW_ACCESS_ISSUER,
      expectedAudience: 'integration-gateway',
      expectedTenantId: config.TENANT_ID,
      expectedEnvironmentId: config.ENVIRONMENT_ID,
    };
    const verifyWorkflowAccessAssertion = createHmacWorkflowAccessAssertionVerifier(workflowVerifierOptions);
    const verifyWorkflowRefundExecutionAssertion = createHmacWorkflowAccessAssertionVerifier({ ...workflowVerifierOptions, expectedPurpose: 'refund_execute' });
    const verifyWorkflowRefundReconciliationAssertion = createHmacWorkflowAccessAssertionVerifier({ ...workflowVerifierOptions, expectedPurpose: 'refund_reconcile' });
    const providerWebhookVerifier = config.PROVIDER_WEBHOOK_HMAC_SECRET === undefined
      ? undefined
      : createHmacProviderRefundEventVerifier(config.PROVIDER_WEBHOOK_HMAC_SECRET);
    temporalConnection = config.PROVIDER_WEBHOOK_HMAC_SECRET === undefined
      ? undefined
      : await Connection.connect({ address: config.TEMPORAL_ADDRESS });
    const signalProviderRefundOutcome = temporalConnection === undefined
      ? undefined
      : createTemporalProviderRefundOutcomeSignaler(new WorkflowClient({ connection: temporalConnection }));
    app = buildApp({
      commerceProvider,
      verifyContextAssertion,
      verifyWorkflowAccessAssertion,
      verifyWorkflowRefundExecutionAssertion,
      verifyWorkflowRefundReconciliationAssertion,
      ...(providerWebhookVerifier === undefined ? {} : { verifyProviderRefundEventSignature: providerWebhookVerifier }),
      refundExecutionRepository,
      logger: true,
      telemetry,
    });

    let isDispatchingProviderEvents = false;
    const dispatchPendingProviderEvents = async (): Promise<void> => {
      if (!signalProviderRefundOutcome || isDispatchingProviderEvents) return;
      isDispatchingProviderEvents = true;
      try {
        for (const event of await refundExecutionRepository.listPendingProviderRefundEvents(100)) {
          try {
            await signalProviderRefundOutcome(event);
            await refundExecutionRepository.markProviderRefundEventDelivered(event.eventId);
          } catch {
            app?.log.warn('provider.refund_event.delivery_deferred');
          }
        }
      } finally {
        isDispatchingProviderEvents = false;
      }
    };

    await app.listen({ host: config.HOST, port: config.PORT });
    refundOperationsObserver.start();
    providerEventDispatchInterval = setInterval(() => { void dispatchPendingProviderEvents(); }, 5_000);
    return { app, close };
  } catch (error) {
    await close();
    throw error;
  }
}
