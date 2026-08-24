import { randomUUID } from 'node:crypto';

import { loadConfig } from './config.js';
import { createHumanOperationsCaseClient } from './human-operations-case-client.js';
import { createIntegrationGatewayRefundContextClient } from './integration-gateway-client.js';
import { createRefundWorkflowActivities } from './refund-workflow-activities.js';
import { REFUND_POLICY_V1 } from './refund-policy-release.js';
import { runRefundWorker } from './refund-worker.js';
import { createHmacWorkflowAccessAssertionSigner } from './workflow-access-assertion.js';

const config = loadConfig();
const signWorkflowAccessAssertion = createHmacWorkflowAccessAssertionSigner({
  secret: config.WORKFLOW_ACCESS_HMAC_SECRET,
  issuer: config.WORKFLOW_ACCESS_ISSUER,
  audience: 'integration-gateway',
});
const integrationGateway = createIntegrationGatewayRefundContextClient({
  baseUrl: config.INTEGRATION_GATEWAY_BASE_URL,
  signWorkflowAccessAssertion,
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const signHumanOperationsAssertion = createHmacWorkflowAccessAssertionSigner({
  secret: config.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET,
  issuer: config.HUMAN_OPERATIONS_WORKFLOW_ISSUER,
  audience: 'human-operations',
});
const humanOperations = createHumanOperationsCaseClient({
  baseUrl: config.HUMAN_OPERATIONS_BASE_URL,
  signWorkflowAccessAssertion: signHumanOperationsAssertion,
  expectedTenantId: config.TENANT_ID,
  expectedEnvironmentId: config.ENVIRONMENT_ID,
});
const activities = createRefundWorkflowActivities({
  fetchRefundContext: integrationGateway.fetchRefundContext,
  executeRefund: integrationGateway.executeRefund,
  reconcileRefund: integrationGateway.reconcileRefund,
  openHumanCase: humanOperations.openHumanCase,
  closeHumanCase: humanOperations.closeHumanCase,
  refundPolicyRelease: REFUND_POLICY_V1,
  createDecisionContext: () => ({
    decisionId: randomUUID(),
    decidedAt: new Date().toISOString(),
  }),
  createPreviewContext: () => ({
    previewId: randomUUID(),
    createdAt: new Date().toISOString(),
  }),
});

await runRefundWorker({
  taskQueue: config.TEMPORAL_TASK_QUEUE,
  activities,
  temporalAddress: config.TEMPORAL_ADDRESS,
});
