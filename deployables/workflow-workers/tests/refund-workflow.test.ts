import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type { RefundWorkflowActivities } from "../src/refund-workflow-activities.js";
import type { RefundProposal } from "../src/refund-policy-input.js";
import type { RefundPolicyDecision } from "../src/refund-policy.js";
import {
  confirmRefund,
  refundWorkflow,
  type RefundWorkflowRequest,
} from "../src/refund-workflow.js";

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

function makeActivities(
  decision: RefundPolicyDecision,
): RefundWorkflowActivities {
  return {
    async refreshRefundContext() {
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
          refundableAmount: { amountMinor: 5_000, currency: "USD" },
          refundDestination: "ORIGINAL_PAYMENT_METHOD",
        },
      };
    },
    async evaluateRefundPolicy() {
      return decision;
    },
    async createRefundPreview() {
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
    assert.equal(result.stage, "CONFIRMED");
    assert.equal(result.decision?.effect, "ALLOW");
    assert.equal(result.preview?.previewId, 'preview-001');
  });
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
