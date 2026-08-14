import { createAgentRuntimeClient } from './agent-runtime-client.js';
import { Connection, WorkflowClient } from '@temporalio/client';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createHmacContextAssertionSigner } from './context-assertion.js';
import { createLocalCustomerIdentityVerifier } from './local-customer-auth.js';
import { createTemporalRefundClient } from './temporal-refund-client.js';

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
  route: {
    homeRegion: config.HOME_REGION,
    homeCell: config.HOME_CELL,
    routingEpoch: config.ROUTING_EPOCH,
  },
});
const signAgentRuntimeContextAssertion = createHmacContextAssertionSigner({
  secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
  issuer: config.CONTEXT_ASSERTION_ISSUER,
  audience: config.AGENT_RUNTIME_CONTEXT_ASSERTION_AUDIENCE,
  route: {
    homeRegion: config.HOME_REGION,
    homeCell: config.HOME_CELL,
    routingEpoch: config.ROUTING_EPOCH,
  },
});
const signKnowledgeRagContextAssertion = createHmacContextAssertionSigner({
  secret: config.CONTEXT_ASSERTION_HMAC_SECRET,
  issuer: config.CONTEXT_ASSERTION_ISSUER,
  audience: config.KNOWLEDGE_RAG_CONTEXT_ASSERTION_AUDIENCE,
  route: {
    homeRegion: config.HOME_REGION,
    homeCell: config.HOME_CELL,
    routingEpoch: config.ROUTING_EPOCH,
  },
});
const agentRuntimeClient = createAgentRuntimeClient({
  baseUrl: config.AGENT_RUNTIME_BASE_URL,
});
const temporalConnection = await Connection.connect({
  address: config.TEMPORAL_ADDRESS,
});
const temporalRefundClient = createTemporalRefundClient({
  client: new WorkflowClient({ connection: temporalConnection }),
  taskQueue: config.TEMPORAL_TASK_QUEUE,
});
const app = buildApp({
  verifyCustomerIdentity,
  signContextAssertion,
  signAgentRuntimeContextAssertion,
  signKnowledgeRagContextAssertion,
  intakeRefund: agentRuntimeClient.intakeRefund,
  startRefundWorkflow: temporalRefundClient.startRefundWorkflow,
  getRefundWorkflow: temporalRefundClient.getRefundWorkflow,
  confirmRefundWorkflow: temporalRefundClient.confirmRefundWorkflow,
  refundPolicyVersion: config.REFUND_POLICY_VERSION,
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
