import Fastify, { type FastifyInstance } from 'fastify';

import type { CommerceProvider } from './commerce.js';
import { createGetOrderContext } from './get-order-context.js';
import { createGetRefundContext } from './get-refund-context.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerOrderRoutes } from './order-routes.js';
import { registerRefundContextRoutes } from './refund-context-routes.js';
import { registerRefundExecutionRoutes } from './refund-execution-routes.js';
import { registerRefundReconciliationRoutes } from './refund-reconciliation-routes.js';
import { registerProviderRefundEventRoutes, type VerifyProviderRefundEventSignature } from './provider-refund-event-routes.js';
import { InMemoryRefundExecutionRepository, type RefundExecutionRepository } from './refund-execution-repository.js';
import type { VerifyContextAssertion } from './trusted-context.js';
import type { VerifyWorkflowAccessAssertion } from './workflow-access.js';

type BuildAppOptions = {
  commerceProvider: CommerceProvider;
  verifyContextAssertion: VerifyContextAssertion;
  verifyWorkflowAccessAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowRefundExecutionAssertion?: VerifyWorkflowAccessAssertion;
  verifyWorkflowRefundReconciliationAssertion?: VerifyWorkflowAccessAssertion;
  refundExecutionRepository?: RefundExecutionRepository;
  verifyProviderRefundEventSignature?: VerifyProviderRefundEventSignature;
  logger?: boolean;
};

export function buildApp(
  options: BuildAppOptions,
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
  });

  app.get('/health', async () => ({
    service: 'integration-gateway',
    status: 'ok',
  }));

  const getOrderContext = createGetOrderContext({
    commerceProvider: options.commerceProvider,
  });
  const getRefundContext = createGetRefundContext({
    commerceProvider: options.commerceProvider,
  });

  registerOrderRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );
  registerRefundContextRoutes(
    app,
    getRefundContext,
    options.verifyContextAssertion,
    options.verifyWorkflowAccessAssertion,
  );
  const refundExecutionRepository = options.refundExecutionRepository ?? new InMemoryRefundExecutionRepository();
  registerRefundExecutionRoutes(app, options.commerceProvider, refundExecutionRepository, options.verifyWorkflowRefundExecutionAssertion);
  registerRefundReconciliationRoutes(app, options.commerceProvider, refundExecutionRepository, options.verifyWorkflowRefundReconciliationAssertion);
  registerProviderRefundEventRoutes(app, refundExecutionRepository, options.verifyProviderRefundEventSignature);
  registerMcpRoutes(
    app,
    getOrderContext,
    options.verifyContextAssertion,
  );

  return app;
}
