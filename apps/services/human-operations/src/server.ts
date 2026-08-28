import { Connection, WorkflowClient } from '@temporalio/client';
import { Pool } from 'pg';

import { buildApp, deliverOutbox, type SendDecision } from './app.js';
import { createHumanAssertionVerifier } from './human-access.js';
import { PostgresHumanCaseRepository } from './postgres-human-case-repository.js';
import { createWorkflowCaseAccessVerifier } from './workflow-access.js';

const secret = process.env.HUMAN_ACCESS_HMAC_SECRET;
const tenantId = process.env.TENANT_ID;
const environmentId = process.env.ENVIRONMENT_ID;
const workflowSecret = process.env.HUMAN_OPERATIONS_WORKFLOW_HMAC_SECRET;
const databaseUrl = process.env.DATABASE_URL;
if (!secret || secret.length < 32 || !workflowSecret || workflowSecret.length < 32 || !tenantId || !environmentId || !databaseUrl) {
  throw new Error('INVALID_HUMAN_OPERATIONS_CONFIG');
}

const connection = await Connection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
});
const client = new WorkflowClient({ connection });
const pool = new Pool({ connectionString: databaseUrl });
const repository = new PostgresHumanCaseRepository(pool);
const sendDecision: SendDecision = async ({ workflowId, access, decision, decidedAt, reasonCode }) => {
  const handle = client.getHandle(workflowId);
  const workflowAccess = await handle.query<{ tenantId: string; environmentId: string }>('refund.access');
  if (workflowAccess.tenantId !== access.tenantId || workflowAccess.environmentId !== access.environmentId) {
    throw new Error('WORKFLOW_ACCESS_DENIED');
  }
  await handle.signal('refund.human-decision', {
    decision,
    decidedBy: access.staffId,
    decidedAt: decidedAt ?? new Date().toISOString(),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  });
};
const app = buildApp({
  repository,
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
  sendDecision,
});

let isDispatchingOutbox = false;
let outboxDispatchTimer: ReturnType<typeof setInterval> | undefined;

async function dispatchPendingOutbox() {
  if (isDispatchingOutbox) return;
  isDispatchingOutbox = true;
  try {
    const events = await repository.listPendingOutbox({ tenantId: tenantId!, environmentId: environmentId!, limit: 50 });
    for (const event of events) {
      const delivered = await deliverOutbox(sendDecision, repository, event);
      if (!delivered) console.warn('Human Operations decision outbox delivery deferred', { eventId: event.eventId, workflowId: event.workflowId });
    }
  } finally {
    isDispatchingOutbox = false;
  }
}

try {
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3003) });
  await dispatchPendingOutbox();
  outboxDispatchTimer = setInterval(() => void dispatchPendingOutbox(), 5_000);
  outboxDispatchTimer.unref();
} catch (error) {
  await pool.end();
  throw error;
}

async function shutdown() {
  if (outboxDispatchTimer) clearInterval(outboxDispatchTimer);
  await app.close();
  await pool.end();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
