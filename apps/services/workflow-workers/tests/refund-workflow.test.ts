import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from 'node:timers/promises';

import type { WorkflowHandle } from '@temporalio/client';
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, type WorkerOptions } from "@temporalio/worker";

import type { RefundProposal } from "../src/refund-policy-input.js";
import type { RefundPolicyDecision } from "../src/refund-policy.js";
import {
  confirmRefund,
  decideRefund,
  getRefundWorkflowState,
  isRefundPreviewCurrent,
  recordProviderRefundOutcome,
  refundWorkflow,
  type RefundWorkflowRequest,
} from "../src/refund-workflow.js";
import type {
  CloseHumanCaseInput,
  CreateRefundPreviewActivityInput,
  ExecuteRefundResult,
  OpenHumanCaseInput,
  OpenHumanCaseResult,
  ReconcileRefundResult,
  RefundWorkflowActivities,
} from "../src/refund-workflow-activities.js";
import type { EvidenceSnapshot, RefundEvidenceActivities } from '../src/refund-evidence-client.js';

const proposal: RefundProposal = {
  proposalId: "refund-proposal-001",
  journeyType: "REFUND",
  intent: {
    orderId: "order-001",
    reasonCode: "DAMAGED",
    scope: "FULL_ORDER",
    itemIds: [],
    requestedAmount: { amountMinor: 5_000, currency: "USD" },
  },
};

const request: RefundWorkflowRequest = {
  orderReference: "ORDER-001",
  proposal,
  policyVersion: "refund-policy-v1",
  access: {
    tenantId: "tenant-local",
    environmentId: "local",
    subjectCustomerId: "customer-42",
    requestId: "request-001",
    traceId: "trace-001",
  },
};

function makeDecision(
  effect: RefundPolicyDecision["effect"],
): RefundPolicyDecision {
  return {
    schemaVersion: "1",
    decisionId: "policy-decision-001",
    journeyType: "REFUND",
    effect,
    policyVersion: "refund-policy-v1",
    inputFactsHash: "sha256:policy-input",
    factRefs: [],
    reasonCodes: ["TEST_DECISION"],
    obligations: [],
    missingFacts: [],
    decidedAt: "2026-08-08T12:00:00.000Z",
    validUntil: "2026-08-08T12:15:00.000Z",
  };
}

type ActivityOptions = Readonly<{
  evidence?: RefundEvidenceActivities;
  evaluate?: RefundWorkflowActivities['evaluateRefundPolicy'];
  previewValidUntil?: string;
  previewLifetimeMs?: number;
  executeRefundResult?: ExecuteRefundResult;
  reconcileRefundResult?: ReconcileRefundResult;
  refreshedAmounts?: readonly number[];
  onExecute?: () => void;
  onCreatePreview?: (input: CreateRefundPreviewActivityInput) => void;
  openHumanCase?: (input: OpenHumanCaseInput) => Promise<void> | void;
  closeHumanCase?: (input: CloseHumanCaseInput) => Promise<void> | void;
}>;

function makeActivities(
  decision: RefundPolicyDecision,
  options: ActivityOptions = {},
): (environment: TestWorkflowEnvironment) => RefundWorkflowActivities {
  let refreshCount = 0;
  return (environment) => ({
    ...options.evidence,
    async refreshRefundContext() {
      const amountIndex = Math.min(
        refreshCount++,
        (options.refreshedAmounts?.length ?? 1) - 1,
      );
      const refundableAmountMinor =
        options.refreshedAmounts?.[amountIndex] ?? 5_000;
      return {
        observationId: "refund-context-001",
        observedAt: "2026-08-08T12:00:00.000Z",
        source: {
          provider: "vendure",
          orderId: "order-001",
          factsVersion: "sha256:refund-context",
        },
        selection: { scope: "FULL_ORDER", itemIds: [] },
        facts: {
          customerVerified: true,
          transactionRefundable: true,
          itemSelectionValid: true,
          priorRefundCount: 0,
          refundableAmount: { amountMinor: refundableAmountMinor, currency: "USD" },
          refundDestination: "ORIGINAL_PAYMENT_METHOD",
        },
      };
    },
    async evaluateRefundPolicy(input) {
      return options.evaluate ? options.evaluate(input) : decision;
    },
    async createRefundPreview(input) {
      options.onCreatePreview?.(input);
      return {
        previewId: 'preview-001',
        createdAt: '2026-08-08T12:00:00.000Z',
        proposalId: 'refund-proposal-001',
        orderId: 'order-001',
        selection: { scope: 'FULL_ORDER', itemIds: [] },
        requestedAmount: { amountMinor: 5_000, currency: 'USD' },
        refundDestination: 'ORIGINAL_PAYMENT_METHOD',
        policyVersion: 'refund-policy-v1',
        decisionId: 'policy-decision-001',
        inputFactsHash: 'sha256:policy-input',
        validUntil: options.previewValidUntil ?? new Date(
          await environment.currentTimeMs() + (options.previewLifetimeMs ?? 15 * 60_000),
        ).toISOString(),
      };
    },
    async executeRefund() {
      options.onExecute?.();
      return options.executeRefundResult ?? {
        status: 'SUCCEEDED',
        providerRefundId: 'vendure-refund-001',
      };
    },
    async reconcileRefund() {
      return options.reconcileRefundResult ?? { status: 'NOT_FOUND' };
    },
    async openHumanCase(input) {
      await options.openHumanCase?.(input);
      return { caseId: input.caseId } satisfies OpenHumanCaseResult;
    },
    async closeHumanCase(input) {
      await options.closeHumanCase?.(input);
    },
  });
}

const workflowsPath = fileURLToPath(new URL('../src/refund-workflow.ts', import.meta.url));

const photoRequest: RefundWorkflowRequest = { ...request, policyVersion: 'refund-policy-v2' };
const photoDecision: RefundPolicyDecision = { ...makeDecision('NEEDS_FACTS'),
  policyVersion: 'refund-policy-v2', missingFacts: ['DAMAGE_PHOTO'] };
function photoSnapshot(accepted = false): EvidenceSnapshot {
  return { caseId: 'photo-case', evidenceVersion: accepted ? 2 : 0,
    assessment: accepted ? 'ACCEPTED' : 'UNREVIEWED', readyCount: accepted ? 1 : 0, processingCount: 0,
    ...(accepted ? { accepted: { evidenceVersion: 2, assessmentId: 'assessment-1',
      manifestHash: `sha256:${'a'.repeat(64)}`, observedAt: '2026-09-05T12:00:00Z' } } : {}),
  };
}

test('damaged photo wait survives replay, same case transitions to supervisor, and money still needs exact confirmation', async () => {
  let snapshot = photoSnapshot(); let executions = 0; let opens = 0; let transitions = 0; let evaluations = 0;
  const options: ActivityOptions = {
    onExecute() { executions++; },
    async evaluate(input) {
      evaluations++;
      return input.damageEvidence ? { ...makeDecision('TAKEOVER_REQUIRED'), policyVersion: 'refund-policy-v2' } : photoDecision;
    },
    evidence: {
      async openRefundEvidence() { opens++; return snapshot; },
      async readRefundEvidence() { return snapshot; },
      async transitionRefundEvidence(input) { transitions++; assert.equal(input.evidenceVersion, 2); return { caseId: 'photo-case' }; },
      async closeRefundEvidence() { assert.fail('Takeover needs monetary transition, not evidence-only close'); },
    },
    async openHumanCase() { assert.fail('Must reuse evidence case'); },
  };
  await withWorker(makeActivities(photoDecision, options), async (env, queue, restart) => {
    const handle = await env.workflowClient.start(refundWorkflow, { taskQueue: queue, workflowId: crypto.randomUUID(), args: [photoRequest] });
    await waitForStage(handle, 'AWAITING_CUSTOMER_EVIDENCE');
    assert.equal(executions, 0);
    await restart();
    snapshot = { ...photoSnapshot(), evidenceVersion: 1, readyCount: 1 };
    await env.sleep(30_001);
    await waitForStage(handle, 'AWAITING_EVIDENCE_REVIEW');
    snapshot = photoSnapshot(true);
    await env.sleep(30_001);
    await waitForStage(handle, 'HUMAN_TAKEOVER_REQUIRED');
    assert.equal(executions, 0); assert.equal(opens, 1); assert.equal(transitions, 1);
    await handle.signal(decideRefund, { decision: 'APPROVE_EXCEPTIONAL_REFUND', decidedBy: 'supervisor', decidedAt: '2026-09-05T12:00:00Z' });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.equal(executions, 0); assert.ok(evaluations >= 3);
    await handle.signal(confirmRefund, { previewId: 'preview-001', accepted: true, confirmedAt: '2026-09-05T12:00:00Z' });
    assert.equal((await handle.result()).stage, 'REFUND_SUCCEEDED'); assert.equal(executions, 1);
  });
});

for (const ending of ['declined', 'expired'] as const) {
  test(`accepted photo review closes when an approval preview is ${ending}`, async () => {
    let closes = 0;
    let executions = 0;
    await withWorker(makeActivities(photoDecision, {
      previewLifetimeMs: 60_000,
      onExecute() { executions++; },
      async evaluate(input) {
        return input.damageEvidence ? { ...makeDecision('APPROVAL_REQUIRED'), policyVersion: 'refund-policy-v2' } : photoDecision;
      },
      evidence: {
        async openRefundEvidence() { return photoSnapshot(true); },
        async readRefundEvidence() { return photoSnapshot(true); },
        async transitionRefundEvidence() { assert.fail('No monetary review without customer confirmation'); },
        async closeRefundEvidence(input) {
          assert.equal(input.caseId, 'photo-case');
          assert.equal(input.outcome, 'EVIDENCE_REVIEW_COMPLETED');
          closes++;
        },
      },
    }), async (env, queue) => {
      const handle = await env.workflowClient.start(refundWorkflow, {
        taskQueue: queue, workflowId: crypto.randomUUID(), args: [photoRequest],
      });
      if (ending === 'declined') {
        await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
        await handle.signal(confirmRefund, { previewId: 'preview-001', accepted: false, confirmedAt: new Date().toISOString() });
      }
      assert.equal((await handle.result()).stage, ending === 'declined' ? 'CANCELLED' : 'PREVIEW_INVALIDATED');
      assert.equal(closes, 1, 'Accepted evidence must not remain stranded in the staff queue');
      assert.equal(executions, 0);
    });
  });
}

test('a changed accepted photo revision invalidates the preview before execution', async () => {
  let snapshot = photoSnapshot(true); let executions = 0;
  await withWorker(makeActivities(photoDecision, {
    onExecute() { executions++; },
    async evaluate(input) { return input.damageEvidence ? { ...makeDecision('ALLOW'), policyVersion: 'refund-policy-v2' } : photoDecision; },
    evidence: { async openRefundEvidence() { return snapshot; }, async readRefundEvidence() { return snapshot; },
      async transitionRefundEvidence() { assert.fail('No monetary case for ALLOW'); }, async closeRefundEvidence() {} },
  }), async (env, queue) => {
    const handle = await env.workflowClient.start(refundWorkflow, { taskQueue: queue, workflowId: crypto.randomUUID(), args: [photoRequest] });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    snapshot = { ...snapshot, accepted: { ...snapshot.accepted!, evidenceVersion: 3 } };
    await handle.signal(confirmRefund, { previewId: 'preview-001', accepted: true, confirmedAt: '2026-09-05T12:00:00Z' });
    assert.equal((await handle.result()).stage, 'PREVIEW_INVALIDATED'); assert.equal(executions, 0);
  });
});

test('photo collection deadline closes the review without a refund or monetary approval', async () => {
  let closed = ''; let executions = 0;
  await withWorker(makeActivities(photoDecision, { onExecute() { executions++; }, evidence: {
    async openRefundEvidence() { return photoSnapshot(); }, async readRefundEvidence() { return photoSnapshot(); },
    async transitionRefundEvidence() { assert.fail('Expired evidence must not enter monetary review'); },
    async closeRefundEvidence(input) { closed = input.outcome; },
  } }), async (env, queue) => {
    const handle = await env.workflowClient.start(refundWorkflow, { taskQueue: queue, workflowId: crypto.randomUUID(),
      args: [{ ...photoRequest, evidenceRecovery: { deadline: await env.currentTimeMs() + 60_000, decision: photoDecision } }] });
    assert.equal((await handle.result()).stage, 'EVIDENCE_COLLECTION_EXPIRED');
    assert.equal(closed, 'EVIDENCE_COLLECTION_EXPIRED'); assert.equal(executions, 0);
  });
});

test('photo polling continues as new without extending its original collection deadline', async () => {
  let opens = 0;
  let closed = 0;
  let executions = 0;
  await withWorker(makeActivities(photoDecision, {
    onExecute() { executions++; },
    evidence: {
      async openRefundEvidence() { opens++; return photoSnapshot(); },
      async readRefundEvidence() { return photoSnapshot(); },
      async transitionRefundEvidence() { assert.fail('No accepted photos'); },
      async closeRefundEvidence(input) {
        assert.equal(input.outcome, 'EVIDENCE_COLLECTION_EXPIRED');
        closed++;
      },
    },
  }), async (env, queue) => {
    const deadline = await env.currentTimeMs() + 121 * 30_000;
    const handle = await env.workflowClient.start(refundWorkflow, {
      taskQueue: queue,
      workflowId: crypto.randomUUID(),
      args: [{ ...photoRequest, evidenceRecovery: { deadline, decision: photoDecision } }],
    });
    assert.equal((await handle.result()).stage, 'EVIDENCE_COLLECTION_EXPIRED');
    assert.equal(opens, 2, 'A second run reopens the same bound collection');
    assert.equal(closed, 1);
    assert.equal(executions, 0);
    const history = await env.workflowClient.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
    const continued = history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
      ?.workflowExecutionContinuedAsNewEventAttributes;
    const payload = continued?.input?.payloads?.[0]?.data;
    assert.ok(payload, 'The first run must record continue as new');
    const nextRequest = JSON.parse(Buffer.from(payload).toString('utf8')) as RefundWorkflowRequest;
    assert.equal(nextRequest.evidenceRecovery?.deadline, deadline, 'Continue as new cannot renew the deadline');
  });
});

async function withWorker(
  createActivities: ReturnType<typeof makeActivities>,
  execute: (environment: TestWorkflowEnvironment, taskQueue: string, restart: () => Promise<void>) => Promise<void>,
  options: Pick<WorkerOptions, 'patchActivationCallback'> = {},
): Promise<void> {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `refund-workflow-test-${crypto.randomUUID()}`;
  const workerOptions = {
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath,
    activities: createActivities(environment),
    // Force history replay instead of sticky routing to the worker being replaced.
    maxCachedWorkflows: 0,
  };
  let worker = await Worker.create({ ...workerOptions, ...options });
  let workerRun = worker.run();
  const workerFailure = Promise.withResolvers<never>();
  void workerRun.catch(workerFailure.reject);

  try {
    await Promise.race([workerFailure.promise, execute(environment, taskQueue, async () => {
      await worker.shutdown();
      await workerRun;
      // Restart without the legacy patch override, using the same server/history.
      worker = await Worker.create(workerOptions);
      workerRun = worker.run();
      void workerRun.catch(workerFailure.reject);
    })]);
  } finally {
    await worker.shutdown();
    await workerRun;
    await environment.teardown();
  }
}

async function waitForStage(handle: WorkflowHandle<typeof refundWorkflow>, expectedStage: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const state = await handle.query(getRefundWorkflowState);
    if (state.stage === expectedStage) return state;
    await delay(20);
  }
  assert.fail(`Workflow did not reach ${expectedStage}`);
}

test('refund confirmation deadline is exclusive and malformed dates fail closed', () => {
  const deadline = '2026-09-05T12:15:00.000Z';
  const epoch = Date.parse(deadline);
  assert.equal(isRefundPreviewCurrent(deadline, epoch - 1), true);
  assert.equal(isRefundPreviewCurrent(deadline, epoch), false);
  assert.equal(isRefundPreviewCurrent(deadline, epoch + 1), false);
  assert.equal(isRefundPreviewCurrent('not-a-date', epoch), false);
  assert.equal(isRefundPreviewCurrent('', epoch), false);
});

test("an allowed refund waits for customer confirmation and then completes", async () => {
  await withWorker(makeActivities(makeDecision("ALLOW")), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue,
      workflowId: `refund-${crypto.randomUUID()}`,
      args: [request],
    });

    await handle.signal(confirmRefund, {
      previewId: 'obsolete-preview',
      accepted: true,
      confirmedAt: '2026-08-08T12:00:30.000Z',
    });
    await handle.signal(confirmRefund, {
      previewId: 'preview-001',
      accepted: true,
      confirmedAt: "2026-08-08T12:01:00.000Z",
    });

    const result = await handle.result();
    assert.equal(result.stage, "REFUND_SUCCEEDED");
    assert.equal(result.decision?.effect, "ALLOW");
    assert.equal(result.preview?.previewId, 'preview-001');

    const queriedState = await handle.query('refund.state');
    assert.equal(queriedState.stage, 'REFUND_SUCCEEDED');
  });
});

test('an already expired preview rejects a backdated confirmation without executing', async () => {
  let executions = 0;
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    previewValidUntil: '2000-01-01T00:00:00.000Z',
    onExecute() { executions += 1; },
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue,
      workflowId: `refund-expiry-${crypto.randomUUID()}`,
      args: [request],
    });
    await handle.signal(confirmRefund, {
      previewId: 'preview-001',
      accepted: true,
      confirmedAt: '1999-12-31T23:59:00.000Z',
    });
    assert.equal((await handle.result()).stage, 'PREVIEW_INVALIDATED');
    assert.equal(executions, 0);
  });
});

for (const effect of ['ALLOW', 'APPROVAL_REQUIRED', 'TAKEOVER_REQUIRED'] as const) {
  test(`${effect} preview expires without confirmation and never executes`, async () => {
    let executions = 0;
    let approvalCases = 0;
    await withWorker(makeActivities(makeDecision(effect), {
      previewLifetimeMs: 60_000,
      onExecute() { executions += 1; },
      openHumanCase(input) { if (input.caseType === 'REFUND_APPROVAL') approvalCases += 1; },
    }), async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue, workflowId: `refund-timeout-${crypto.randomUUID()}`, args: [request],
      });
      if (effect === 'TAKEOVER_REQUIRED') {
        await handle.signal(decideRefund, {
          decision: 'APPROVE_EXCEPTIONAL_REFUND', decidedBy: 'supervisor-001',
          decidedAt: new Date(await environment.currentTimeMs()).toISOString(),
        });
      }
      const before = await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
      await handle.signal(confirmRefund, {
        previewId: 'wrong-preview', accepted: true, confirmedAt: '1999-01-01T00:00:00.000Z',
      });
      const after = await handle.query(getRefundWorkflowState);
      assert.equal(after.preview?.validUntil, before.preview?.validUntil);
      const result = await handle.result(); // The isolated server skips to the durable timer.
      assert.equal(result.stage, 'PREVIEW_INVALIDATED');
      assert.equal((await handle.query(getRefundWorkflowState)).stage, 'PREVIEW_INVALIDATED');
      assert.equal(executions, 0);
      assert.equal(approvalCases, 0);
      if (effect === 'ALLOW') {
        await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
      }
    });
  });
}

for (const validUntil of ['invalid-date', '2000-01-01T00:00:00.000Z']) {
  test(`a supervisor cannot revive an unavailable preview (${validUntil})`, async () => {
    let executions = 0;
    await withWorker(makeActivities(makeDecision('TAKEOVER_REQUIRED'), {
      previewValidUntil: validUntil,
      onExecute() { executions += 1; },
    }), async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue, workflowId: `refund-stale-takeover-${crypto.randomUUID()}`, args: [request],
      });
      await handle.signal(decideRefund, {
        decision: 'APPROVE_EXCEPTIONAL_REFUND', decidedBy: 'supervisor-001',
        decidedAt: new Date(await environment.currentTimeMs()).toISOString(),
      });
      const result = await handle.result();
      assert.equal(result.stage, 'PREVIEW_INVALIDATED');
      assert.equal(result.preview?.validUntil, validUntil);
      assert.equal(executions, 0);
    });
  });
}

test('a timely decline cancels the timer and does not execute', async () => {
  let executions = 0;
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    onExecute() { executions += 1; },
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-decline-${crypto.randomUUID()}`, args: [request],
    });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: false, confirmedAt: '1999-01-01T00:00:00.000Z',
    });
    assert.equal((await handle.result()).stage, 'CANCELLED');
    assert.equal(executions, 0);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});

test('timely confirmation remains valid through human approval after the deadline', async () => {
  let executions = 0;
  await withWorker(makeActivities(makeDecision('APPROVAL_REQUIRED'), {
    previewLifetimeMs: 60_000,
    onExecute() { executions += 1; },
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-late-approval-${crypto.randomUUID()}`, args: [request],
    });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: true, confirmedAt: '2999-01-01T00:00:00.000Z',
    });
    const approvedPreview = await waitForStage(handle, 'AWAITING_APPROVAL');
    await environment.sleep(120_000);
    assert.ok(await environment.currentTimeMs() >= Date.parse(approvedPreview.preview!.validUntil));
    // A later duplicate decline cannot replace the first timely acceptance.
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: false, confirmedAt: '1999-01-01T00:00:00.000Z',
    });
    await handle.signal(decideRefund, {
      decision: 'APPROVE', decidedBy: 'supervisor-001',
      decidedAt: new Date(await environment.currentTimeMs()).toISOString(),
    });
    assert.equal((await handle.result()).stage, 'REFUND_SUCCEEDED');
    assert.equal(executions, 1);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});

test('timely confirmation remains valid while provider settlement outlives the deadline', async () => {
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    previewLifetimeMs: 60_000,
    executeRefundResult: { status: 'SUBMITTED', providerRefundId: 'provider-delayed' },
    reconcileRefundResult: { status: 'PROCESSING', providerRefundId: 'provider-delayed' },
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-delayed-provider-${crypto.randomUUID()}`, args: [request],
    });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: true, confirmedAt: '1999-01-01T00:00:00.000Z',
    });
    await waitForStage(handle, 'REFUND_PROCESSING');
    await environment.sleep(120_000);
    await handle.signal(recordProviderRefundOutcome, {
      eventId: 'delayed-settlement', providerRefundId: 'provider-delayed', outcome: 'COMPLETED',
      occurredAt: new Date(await environment.currentTimeMs()).toISOString(),
    });
    assert.equal((await handle.result()).stage, 'REFUND_SUCCEEDED');
  });
});

test('an armed expiry timer survives a worker restart', async () => {
  let executions = 0;
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    previewLifetimeMs: 60_000,
    onExecute() { executions += 1; },
  }), async (environment, taskQueue, restart) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-restart-${crypto.randomUUID()}`, args: [request],
    });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    assert.ok((await handle.fetchHistory()).events?.some(event => event.timerStartedEventAttributes));
    await restart();
    assert.equal((await handle.result()).stage, 'PREVIEW_INVALIDATED');
    assert.equal(executions, 0);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  });
});

// Produce pre-patch command histories without committing a duplicate workflow
// implementation or depending on Git being present when the tests run.
const legacyPatchOptions: Pick<WorkerOptions, 'patchActivationCallback'> = {
  patchActivationCallback: ({ patchId }) => !patchId.startsWith('refund-preview-expiry-'),
};

test('pre-patch completed history replays without retroactively expiring its confirmation', async () => {
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    previewValidUntil: '2000-01-01T00:00:00.000Z',
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-legacy-complete-${crypto.randomUUID()}`, args: [request],
    });
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: true, confirmedAt: '1999-01-01T00:00:00.000Z',
    });
    assert.equal((await handle.result()).stage, 'REFUND_SUCCEEDED');
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  }, legacyPatchOptions);
});

test('a pre-patch parked workflow rejects a late live confirmation after worker replacement', async () => {
  let executions = 0;
  await withWorker(makeActivities(makeDecision('ALLOW'), {
    previewValidUntil: '2000-01-01T00:00:00.000Z',
    onExecute() { executions += 1; },
  }), async (environment, taskQueue, restart) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue, workflowId: `refund-legacy-pending-${crypto.randomUUID()}`, args: [request],
    });
    await waitForStage(handle, 'AWAITING_CUSTOMER_CONFIRMATION');
    await restart();
    // An old parked wait has no retroactively inserted timer, but its next live
    // signal must use the new authoritative deadline guard, not the claimed date.
    await handle.signal(confirmRefund, {
      previewId: 'preview-001', accepted: true, confirmedAt: '1999-01-01T00:00:00.000Z',
    });
    assert.equal((await handle.result()).stage, 'PREVIEW_INVALIDATED');
    assert.equal(executions, 0);
    await Worker.runReplayHistory({ workflowsPath }, await handle.fetchHistory(), handle.workflowId);
  }, legacyPatchOptions);
});

test('a human takeover resolves to its final state', async () => {
  await withWorker(makeActivities(makeDecision('TAKEOVER_REQUIRED')), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue,
      workflowId: `refund-${crypto.randomUUID()}`,
      args: [request],
    });

    await handle.signal(decideRefund, {
      decision: 'RESOLVE_TAKEOVER',
      decidedBy: 'agent-001',
      decidedAt: '2026-08-08T12:02:00.000Z',
    });

    const result = await handle.result();
    assert.equal(result.stage, 'TAKEOVER_RESOLVED');
  });
});

test('a supervisor exceptional approval creates a trusted preview, then waits for customer confirmation', async () => {
  let receivedCase: OpenHumanCaseInput | undefined;
  let closedCase: CloseHumanCaseInput | undefined;
  let previewInput: CreateRefundPreviewActivityInput | undefined;
  let executions = 0;

  await withWorker(
    makeActivities(makeDecision('TAKEOVER_REQUIRED'), {
      openHumanCase(input) { receivedCase = input; },
      closeHumanCase(input) { closedCase = input; },
      onCreatePreview(input) { previewInput = input; },
      onExecute() { executions += 1; },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(decideRefund, {
        decision: 'APPROVE_EXCEPTIONAL_REFUND',
        decidedBy: 'supervisor-001',
        decidedAt: '2026-08-08T12:02:00.000Z',
        reasonCode: 'SUPERVISOR_EXCEPTION_APPROVED',
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:03:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_SUCCEEDED');
      assert.equal(executions, 1);
      assert.deepEqual(receivedCase?.allowedActions, [
        'APPROVE_EXCEPTIONAL_REFUND',
        'RESOLVE_TAKEOVER',
        'REJECT',
      ]);
      assert.equal(closedCase?.outcome, 'APPROVED');
      assert.equal(closedCase?.decision.action, 'APPROVE_EXCEPTIONAL_REFUND');
      assert.equal(closedCase?.decision.reasonCode, 'SUPERVISOR_EXCEPTION_APPROVED');
      assert.equal(previewInput?.authorization?.kind, 'HUMAN_EXCEPTIONAL_APPROVAL');
      assert.equal(previewInput?.authorization?.caseId, closedCase?.caseId);
      assert.deepEqual(previewInput?.proposal, proposal);
    },
  );
});

test('opens a takeover case before entering the human wait state, with only takeover actions', async () => {
  let releaseOpenCase: (() => void) | undefined;
  const caseOpenStarted = new Promise<void>((resolve) => {
    releaseOpenCase = resolve;
  });
  let allowCaseOpen: (() => void) | undefined;
  const caseOpenCanFinish = new Promise<void>((resolve) => {
    allowCaseOpen = resolve;
  });
  let receivedCase: OpenHumanCaseInput | undefined;

  await withWorker(
    makeActivities(makeDecision('TAKEOVER_REQUIRED'), {
      async openHumanCase(input) {
        receivedCase = input;
        releaseOpenCase?.();
        await caseOpenCanFinish;
      },
    }),
    async (environment, taskQueue) => {
      const workflowId = `refund-${crypto.randomUUID()}`;
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId,
        args: [request],
      });

      await caseOpenStarted;
      const whileCaseIsOpening = await handle.query('refund.state');
      assert.equal(whileCaseIsOpening.stage, 'EVALUATING');

      allowCaseOpen?.();
      await handle.signal(decideRefund, {
        decision: 'RESOLVE_TAKEOVER',
        decidedBy: 'supervisor-001',
        decidedAt: '2026-08-08T12:02:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'TAKEOVER_RESOLVED');
      assert.deepEqual(receivedCase?.allowedActions, [
        'APPROVE_EXCEPTIONAL_REFUND',
        'RESOLVE_TAKEOVER',
        'REJECT',
      ]);
      assert.equal(receivedCase?.caseType, 'REFUND_TAKEOVER');
      assert.equal(receivedCase?.caseId, `case:${workflowId}`);
      assert.equal(receivedCase?.reviewPacket.orderReference, 'ORDER-001');
      assert.equal(receivedCase?.reviewPacket.preview, undefined);
    },
  );
});

test("a denied refund completes without waiting for customer confirmation", async () => {
  await withWorker(makeActivities(makeDecision("DENY")), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue,
      workflowId: `refund-${crypto.randomUUID()}`,
      args: [request],
    });

    const result = await handle.result();
    assert.equal(result.stage, "DENIED");
    assert.equal(result.decision?.effect, "DENY");
  });
});

test('an approval-required refund waits for customer confirmation and a human approval', async () => {
  let receivedCase: OpenHumanCaseInput | undefined;
  await withWorker(makeActivities(makeDecision('APPROVAL_REQUIRED'), {
    openHumanCase(input) { receivedCase = input; },
  }), async (environment, taskQueue) => {
    const handle = await environment.workflowClient.start(refundWorkflow, {
      taskQueue,
      workflowId: `refund-${crypto.randomUUID()}`,
      args: [request],
    });
    await handle.signal(confirmRefund, { previewId: 'preview-001', accepted: true, confirmedAt: '2026-08-08T12:01:00.000Z' });
    await handle.signal(decideRefund, { decision: 'APPROVE', decidedBy: 'agent-001', decidedAt: '2026-08-08T12:02:00.000Z' });

    const result = await handle.result();
    assert.equal(result.stage, 'REFUND_SUCCEEDED');
    assert.equal(result.preview?.previewId, 'preview-001');

    const queriedState = await handle.query('refund.state');
    assert.equal(queriedState.stage, 'REFUND_SUCCEEDED');
    assert.deepEqual(receivedCase?.allowedActions, ['APPROVE', 'REJECT']);
    assert.equal(receivedCase?.caseType, 'REFUND_APPROVAL');
    assert.equal(receivedCase?.reviewPacket.preview?.previewId, 'preview-001');
  });
});

test('closes the takeover case only after the final human decision', async () => {
  const events: string[] = [];
  let closedCase: CloseHumanCaseInput | undefined;
  await withWorker(
    makeActivities(makeDecision('TAKEOVER_REQUIRED'), {
      openHumanCase() { events.push('opened'); },
      closeHumanCase(input) { events.push('closed'); closedCase = input; },
    }),
    async (environment, taskQueue) => {
      const workflowId = `refund-${crypto.randomUUID()}`;
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId,
        args: [request],
      });
      await handle.signal(decideRefund, {
        decision: 'REJECT',
        decidedBy: 'supervisor-001',
        decidedAt: '2026-08-08T12:02:00.000Z',
        reasonCode: 'MANUAL_REJECTION',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REJECTED');
      assert.deepEqual(events, ['opened', 'closed']);
      assert.equal(closedCase?.caseId, `case:${workflowId}`);
      assert.equal(closedCase?.outcome, 'REJECTED');
      assert.equal(closedCase?.decision.action, 'REJECT');
      assert.equal(closedCase?.decision.reasonCode, 'MANUAL_REJECTION');
    },
  );
});

test('duplicate customer confirmation executes the refund only once', async () => {
  let executions = 0;
  await withWorker(
    makeActivities(makeDecision('ALLOW'), { onExecute: () => { executions += 1; } }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      const confirmation = {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      };
      await handle.signal(confirmRefund, confirmation);
      await handle.signal(confirmRefund, confirmation);

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_SUCCEEDED');
      assert.equal(executions, 1);
    },
  );
});

test('invalidates a preview when the refundable balance changes', async () => {
  let executions = 0;
  await withWorker(
    makeActivities(makeDecision('ALLOW'), {
      refreshedAmounts: [5_000, 4_000],
      onExecute: () => { executions += 1; },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'PREVIEW_INVALIDATED');
      assert.equal(executions, 0);
    },
  );
});

test('provider failure does not report a successful refund', async () => {
  await withWorker(
    makeActivities(makeDecision('ALLOW'), {
      executeRefundResult: { status: 'FAILED' },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_FAILED');
    },
  );
});

test('a pending provider result is resolved by reconciliation', async () => {
  await withWorker(
    makeActivities(makeDecision('ALLOW'), {
      executeRefundResult: { status: 'PENDING_RECONCILIATION' },
      reconcileRefundResult: {
        status: 'SUCCEEDED',
        providerRefundId: 'vendure-refund-reconciled',
      },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_SUCCEEDED');
      assert.equal(result.providerRefundId, 'vendure-refund-reconciled');
    },
  );
});

test('a submitted refund remains in processing until a matching provider event confirms completion', async () => {
  await withWorker(
    makeActivities(makeDecision('ALLOW'), {
      executeRefundResult: { status: 'SUBMITTED', providerRefundId: 'provider-refund-001' },
      reconcileRefundResult: { status: 'PROCESSING', providerRefundId: 'provider-refund-001' },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      });
      await handle.signal(recordProviderRefundOutcome, {
        eventId: 'provider-event-001',
        providerRefundId: 'provider-refund-001',
        outcome: 'COMPLETED',
        occurredAt: '2026-08-08T12:02:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_SUCCEEDED');
      assert.equal(result.providerRefundId, 'provider-refund-001');
    },
  );
});

test('a submitted refund becomes failed when its provider reports failure', async () => {
  await withWorker(
    makeActivities(makeDecision('ALLOW'), {
      executeRefundResult: { status: 'SUBMITTED', providerRefundId: 'provider-refund-002' },
      reconcileRefundResult: { status: 'PROCESSING', providerRefundId: 'provider-refund-002' },
    }),
    async (environment, taskQueue) => {
      const handle = await environment.workflowClient.start(refundWorkflow, {
        taskQueue,
        workflowId: `refund-${crypto.randomUUID()}`,
        args: [request],
      });

      await handle.signal(confirmRefund, {
        previewId: 'preview-001',
        accepted: true,
        confirmedAt: '2026-08-08T12:01:00.000Z',
      });
      await handle.signal(recordProviderRefundOutcome, {
        eventId: 'provider-event-002',
        providerRefundId: 'provider-refund-002',
        outcome: 'FAILED',
        occurredAt: '2026-08-08T12:02:00.000Z',
      });

      const result = await handle.result();
      assert.equal(result.stage, 'REFUND_FAILED');
    },
  );
});
