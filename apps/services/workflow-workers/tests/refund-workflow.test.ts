import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type { RefundProposal } from "../src/refund-policy-input.js";
import type { RefundPolicyDecision } from "../src/refund-policy.js";
import {
  confirmRefund,
  decideRefund,
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
): RefundWorkflowActivities {
  let refreshCount = 0;
  return {
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
    async evaluateRefundPolicy() {
      return decision;
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
        validUntil: '2026-08-08T12:15:00.000Z',
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
  };
}

async function withWorker(
  activities: RefundWorkflowActivities,
  execute: (environment: TestWorkflowEnvironment, taskQueue: string) => Promise<void>,
): Promise<void> {
  const environment = await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `refund-workflow-test-${crypto.randomUUID()}`;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("../src/refund-workflow.ts", import.meta.url),
    ),
    activities,
  });
  const workerRun = worker.run();

  try {
    await execute(environment, taskQueue);
  } finally {
    await worker.shutdown();
    await workerRun;
    await environment.teardown();
  }
}

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
