#!/usr/bin/env node
/**
 * Isolated browser-visible expiry smoke test. No Gateway, model, or commerce I/O.
 * Uses existing workflow-workers dependencies; creates one synthetic Temporal
 * workflow in the local default namespace, on a unique dedicated task queue.
 *
 * Check only (no network): node tools/testing/refund-preview-expiry-smoke.mjs --check
 * After explicit approval and browser readiness:
 *   node tools/testing/refund-preview-expiry-smoke.mjs --run --lifetime-seconds=90
 * Use Node 22.21.0 if the local Temporal Worker fails on Node 24 (see runbook).
 * Wait for READY, open customerUrl, and DO NOT confirm or decline the preview.
 * PASSED requires natural expiry, an Edge HTTP 409 for late confirmation, and
 * zero workflow confirmation signals / refund execution activity attempts.
 * --hold-seconds=0..180 optionally keeps the worker available after verification.
 * Completed history is retained, but closed-workflow queries still require a
 * poller on the fixture's unique queue; use the hold window for browser checks.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repository = new URL('../../', import.meta.url);
const workerDirectory = new URL('apps/services/workflow-workers/', repository);
const requireWorker = createRequire(new URL('package.json', workerDirectory));
const { Connection, WorkflowClient } = requireWorker('@temporalio/client');
const { Worker, NativeConnection, Runtime, DefaultLogger } = requireWorker('@temporalio/worker');
const { ApplicationFailure } = requireWorker('@temporalio/workflow');

const argumentsList = process.argv.slice(2);
const mode = argumentsList.includes('--run') ? 'run' : argumentsList.includes('--check') ? 'check' : 'help';
const lifetimeArgument = argumentsList.find(argument => argument.startsWith('--lifetime-seconds='));
const lifetimeSeconds = Number(lifetimeArgument?.split('=')[1] ?? 90);
const holdArgument = argumentsList.find(argument => argument.startsWith('--hold-seconds='));
const holdSeconds = Number(holdArgument?.split('=')[1] ?? 0);
if (argumentsList.some(argument => !['--run', '--check', '--help'].includes(argument) && argument !== lifetimeArgument && argument !== holdArgument)
  || (argumentsList.includes('--run') && argumentsList.includes('--check'))
  || !Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 90
  || !Number.isInteger(holdSeconds) || holdSeconds < 0 || holdSeconds > 180) {
  throw new Error('Use --check or --run, optional --lifetime-seconds=60..90 and --hold-seconds=0..180.');
}

if (mode === 'help') {
  console.log('Usage: node tools/testing/refund-preview-expiry-smoke.mjs --check | --run [--lifetime-seconds=60..90] [--hold-seconds=0..180]');
  process.exit(0);
}

// Do not load secrets into process.env or print either environment file.
const edgeConfig = parseEnv(readFileSync(new URL('apps/services/edge-api/.env', repository), 'utf8'));
const workerConfig = parseEnv(readFileSync(new URL('.env', workerDirectory), 'utf8'));
const customerToken = parseEnv(readFileSync(new URL('apps/web/customer-portal/.env.local', repository), 'utf8')).CSO_LOCAL_CUSTOMER_TOKEN;
assert.ok(customerToken, 'Customer Portal local token is required for the Edge verification.');
const address = workerConfig.TEMPORAL_ADDRESS ?? '127.0.0.1:7233';
assert.ok(['127.0.0.1:7233', 'localhost:7233'].includes(address), 'Only the local Temporal development server is allowed.');
assert.equal(edgeConfig.TEMPORAL_ADDRESS ?? '127.0.0.1:7233', address, 'Edge and worker must use the same local Temporal address.');
for (const field of ['TENANT_ID', 'ENVIRONMENT_ID', 'LOCAL_CUSTOMER_ID']) {
  assert.ok(edgeConfig[field]?.trim(), `Edge configuration is missing ${field}.`);
}

if (mode === 'check') {
  console.log(JSON.stringify({ status: 'CHECKED', localTemporalOnly: true, namespace: 'default', ownershipConfigured: true, customerTokenConfigured: true, lifetimeSeconds, holdSeconds, mockedActivitiesOnly: true }));
  process.exit(0);
}

const fixtureId = randomUUID();
const workflowId = `refund-expiry-smoke-${fixtureId}`;
const taskQueue = `refund-expiry-smoke-queue-${fixtureId}`;
const previewId = `expiry-smoke-preview-${fixtureId}`;
const orderId = `expiry-smoke-NO-PROVIDER-order-${fixtureId}`;
const proposalId = `expiry-smoke-proposal-${fixtureId}`;
const decisionId = `expiry-smoke-decision-${fixtureId}`;
const inputFactsHash = `sha256:${'0'.repeat(64)}`;
const amount = { amountMinor: 5_000, currency: 'USD' };
let executeAttempts = 0;
let forbiddenActivityAttempts = 0;
let clientConnection;
let nativeConnection;
let currentCheck = 'worker_setup';

/** @param {string} path @param {RequestInit} [init] */
async function edgeRequest(path, init = {}) {
  const response = await fetch(new URL(path, 'http://127.0.0.1:3000'), {
    ...init, headers: { ...init.headers, authorization: `Bearer ${customerToken}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

/** @param {string} name @returns {never} */
function forbiddenActivity(name) {
  forbiddenActivityAttempts += 1;
  throw ApplicationFailure.nonRetryable(`ISOLATED_EXPIRY_SMOKE_FORBIDS_${name}`, 'SMOKE_FORBIDDEN_ACTIVITY');
}

/** @type {import('../../apps/services/workflow-workers/src/refund-workflow-activities.js').RefundWorkflowActivities} */
const activities = {
  async refreshRefundContext() {
    return {
      observationId: `expiry-smoke-context-${fixtureId}`,
      observedAt: new Date().toISOString(),
      source: { provider: 'isolated-smoke-NO-PROVIDER', orderId, factsVersion: inputFactsHash },
      selection: { scope: 'FULL_ORDER', itemIds: [] },
      facts: {
        customerVerified: true,
        transactionRefundable: true,
        itemSelectionValid: true,
        priorRefundCount: 0,
        refundableAmount: amount,
        refundDestination: 'ORIGINAL_PAYMENT_METHOD',
      },
    };
  },
  async evaluateRefundPolicy() {
    const now = Date.now();
    return {
      schemaVersion: '1', decisionId, journeyType: 'REFUND', effect: 'ALLOW',
      policyVersion: 'refund-policy-v1', inputFactsHash,
      factRefs: [], reasonCodes: ['ISOLATED_EXPIRY_SMOKE'], obligations: [], missingFacts: [],
      decidedAt: new Date(now).toISOString(),
      validUntil: new Date(now + lifetimeSeconds * 1_000).toISOString(),
    };
  },
  async createRefundPreview({ decision }) {
    return {
      previewId, createdAt: new Date().toISOString(), proposalId, orderId,
      selection: { scope: 'FULL_ORDER', itemIds: [] }, requestedAmount: amount,
      refundDestination: 'ORIGINAL_PAYMENT_METHOD', policyVersion: decision.policyVersion,
      decisionId, inputFactsHash, validUntil: decision.validUntil,
    };
  },
  async executeRefund() { executeAttempts += 1; return forbiddenActivity('executeRefund'); },
  async reconcileRefund() { return forbiddenActivity('reconcileRefund'); },
  async openHumanCase() { return forbiddenActivity('openHumanCase'); },
  async closeHumanCase() { return forbiddenActivity('closeHumanCase'); },
};

try {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  clientConnection = await Connection.connect({ address });
  nativeConnection = await NativeConnection.connect({ address });
  const client = new WorkflowClient({ connection: clientConnection, namespace: 'default' });
  const worker = await Worker.create({
    connection: nativeConnection, namespace: 'default', taskQueue,
    workflowsPath: fileURLToPath(new URL('src/refund-workflow.ts', workerDirectory)),
    activities,
  });
  await worker.runUntil(async () => {
    currentCheck = 'workflow_start';
    const handle = await client.start('refundWorkflow', {
      workflowId, taskQueue,
      // Bound a broken smoke test without cancelling/resetting any other workflow.
      workflowExecutionTimeout: `${lifetimeSeconds + 120} seconds`,
      args: [{
        orderReference: `EXPIRY-SMOKE-${fixtureId.slice(0, 8)}`,
        proposal: {
          proposalId, journeyType: 'REFUND',
          intent: { orderId, reasonCode: 'DAMAGED', scope: 'FULL_ORDER', itemIds: [], requestedAmount: amount },
        },
        policyVersion: 'refund-policy-v1',
        access: {
          tenantId: edgeConfig.TENANT_ID, environmentId: edgeConfig.ENVIRONMENT_ID,
          subjectCustomerId: edgeConfig.LOCAL_CUSTOMER_ID, requestId: randomUUID(), traceId: randomUUID(),
        },
      }],
    });
    // Poll only the new fixture, and report readiness before waiting for expiry.
    const readinessDeadline = Date.now() + 30_000;
    let ready;
    while (Date.now() < readinessDeadline) {
      const state = await handle.query('refund.state');
      if (state.stage === 'AWAITING_CUSTOMER_CONFIRMATION') { ready = state; break; }
      assert.equal(state.stage, 'EVALUATING', 'Fixture reached an unexpected stage before readiness.');
      await delay(100);
    }
    assert.ok(ready?.preview, 'Fixture did not produce a confirmation-ready preview within 30 seconds.');
    console.log(JSON.stringify({
      status: 'READY', workflowId, taskQueue, previewId,
      validUntil: ready.preview.validUntil,
      customerUrl: `http://127.0.0.1:3100/refunds/${workflowId}`,
      instruction: 'Do not confirm or decline. Wait for natural preview expiry.',
    }));
    currentCheck = 'natural_expiry';
    const result = await handle.result();
    const queried = await handle.query('refund.state');
    assert.equal(result.stage, 'PREVIEW_INVALIDATED');
    assert.equal(queried.stage, 'PREVIEW_INVALIDATED');

    // Keep this dedicated worker polling until all closed-workflow queries and
    // the negative confirmation finish. Stopping it first produces a query 502.
    currentCheck = 'edge_terminal_workflow';
    const edgeWorkflow = await edgeRequest(`/v1/refunds/${workflowId}`);
    assert.equal(edgeWorkflow.status, 200);
    assert.equal(edgeWorkflow.body.stage, 'PREVIEW_INVALIDATED');
    currentCheck = 'edge_terminal_journey';
    const edgeJourney = await edgeRequest(`/v1/refunds/${workflowId}/journey`);
    assert.equal(edgeJourney.status, 200);
    assert.equal(edgeJourney.body.stage, 'PREVIEW_EXPIRED');
    assert.equal(edgeJourney.body.next_action?.type, 'NONE');
    currentCheck = 'edge_late_confirmation';
    const lateConfirmation = await edgeRequest(`/v1/refunds/${workflowId}/confirmation`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preview_id: previewId, accepted: true }),
    });
    assert.equal(lateConfirmation.status, 409);
    assert.equal(lateConfirmation.body.error?.code, 'refund_preview_unavailable');
    currentCheck = 'post_confirmation_history';
    /** @type {Awaited<ReturnType<import('../../apps/services/workflow-workers/node_modules/@temporalio/client/lib/index.js').WorkflowHandle['fetchHistory']>>} */
    const history = await handle.fetchHistory();
    /** @type {any[]} Temporal's exported History currently exposes untyped protobuf events. */
    const events = history.events ?? [];
    const executeScheduled = events.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === 'executeRefund').length;
    const confirmationSignals = events.filter(event => event.workflowExecutionSignaledEventAttributes?.signalName === 'refund.confirmation').length;
    const timerStarted = events.some(event => event.timerStartedEventAttributes);
    const patchIds = events.flatMap(event => {
      const attributes = event.markerRecordedEventAttributes;
      return Object.values(attributes?.details ?? {}).flatMap(detail => detail.payloads ?? []).flatMap(payload => {
        try { const parsed = JSON.parse(Buffer.from(payload.data ?? []).toString()); return typeof parsed.id === 'string' ? [parsed.id] : []; }
        catch { return []; }
      });
    });
    assert.equal(executeAttempts, 0);
    assert.equal(executeScheduled, 0);
    assert.equal(forbiddenActivityAttempts, 0);
    assert.equal(confirmationSignals, 0, 'This smoke test requires natural expiry without confirmation signals.');
    assert.ok(timerStarted, 'Expected a durable expiry timer.');
    assert.ok(patchIds.includes('refund-preview-expiry-timer-v1'), 'Expected the current expiry timer patch marker.');
    console.log(JSON.stringify({ status: 'PASSED', workflowId, stage: result.stage, queriedStage: queried.stage,
      edgeWorkflowStatus: edgeWorkflow.status, edgeJourneyStatus: edgeJourney.status, edgeJourneyStage: edgeJourney.body.stage,
      lateConfirmationStatus: lateConfirmation.status, lateConfirmationCode: lateConfirmation.body.error.code,
      executeAttempts, executeScheduled, confirmationSignals, timerStarted,
      expiryPatchIds: patchIds.filter(id => id.startsWith('refund-preview-expiry-')), holdSeconds }));
    if (holdSeconds > 0) {
      currentCheck = 'browser_hold';
      console.log(JSON.stringify({ status: 'HOLDING', workflowId, until: new Date(Date.now() + holdSeconds * 1000).toISOString() }));
      await delay(holdSeconds * 1000);
    }
  });
} catch (error) {
  console.error(JSON.stringify({ status: 'FAILED', workflowId, check: currentCheck, errorName: error instanceof Error ? error.name : 'Error', executeAttempts, forbiddenActivityAttempts }));
  process.exitCode = 1;
} finally {
  await nativeConnection?.close();
  await clientConnection?.close();
}
