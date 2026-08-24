import { Connection, WorkflowClient } from '@temporalio/client';

import { buildApp } from './app.js';
import { createHumanAssertionVerifier } from './human-access.js';
import { createWorkflowCaseAccessVerifier } from './workflow-access.js';

const secret = process.env.HUMAN_ACCESS_HMAC_SECRET;
const tenantId = process.env.TENANT_ID;
const environmentId = process.env.ENVIRONMENT_ID;
const workflowSecret = process.env.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET;
if (!secret || secret.length < 32 || !workflowSecret || workflowSecret.length < 32 || !tenantId || !environmentId) {
  throw new Error('INVALID_HUMAN_OPERATIONS_CONFIG');
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
});
const client = new WorkflowClient({ connection });
const app = buildApp({
  verifyHuman: createHumanAssertionVerifier({
    secret,
    issuer: process.env.HUMAN_ACCESS_ISSUER ?? 'customer-service-os-human-operations',
    audience: 'human-operations',
    tenantId,
    environmentId,
  }),
  verifyWorkflowCaseAccess: createWorkflowCaseAccessVerifier({
    secret: workflowSecret,
    issuer: process.env.HUMAN_OPERATIONS_WORKFLOW_ISSUER ?? 'customer-service-os-workflow-workers',
    audience: 'human-operations',
    tenantId,
    environmentId,
  }),
  async sendDecision({ workflowId, access, decision, reasonCode }) {
    const handle = client.getHandle(workflowId);
    const workflowAccess = await handle.query<{ tenantId: string; environmentId: string }>('refund.access');
    if (workflowAccess.tenantId !== access.tenantId || workflowAccess.environmentId !== access.environmentId) {
      throw new Error('WORKFLOW_ACCESS_DENIED');
    }
    await handle.signal('refund.human-decision', {
      decision,
      decidedBy: access.staffId,
      decidedAt: new Date().toISOString(),
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  },
});

await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3003) });
