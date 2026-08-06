import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRefundPolicyInput,
  type RefundContext,
  type RefundProposal,
} from "../src/refund-policy-input.js";
import { evaluateRefundPolicy } from "../src/refund-policy.js";
import { REFUND_POLICY_V1 } from "../src/refund-policy-release.js";

const proposal: RefundProposal = {
  proposalId: "proposal-1",
  journeyType: "REFUND",
  intent: {
    orderId: "order-3",
    reasonCode: "DAMAGED",
    scope: "SELECTED_ITEMS",
    itemIds: ["line-1"],
    requestedAmount: { amountMinor: 10_000, currency: "USD" },
  },
};

const refundContext: RefundContext = {
  observationId: "refund-context-1",
  observedAt: "2026-08-06T12:00:00.000Z",
  source: {
    provider: "vendure",
    orderId: "order-3",
    factsVersion:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  },
  selection: {
    scope: "SELECTED_ITEMS",
    itemIds: ["line-1"],
  },
  facts: {
    customerVerified: true,
    transactionRefundable: true,
    itemSelectionValid: true,
    refundableAmount: { amountMinor: 10_000, currency: "USD" },
    refundDestination: "ORIGINAL_PAYMENT_METHOD",
  },
};

function createInput(
  overrides: Partial<{
    proposal: RefundProposal;
    refundContext: RefundContext;
  }> = {},
) {
  return createRefundPolicyInput({
    proposal: overrides.proposal ?? proposal,
    refundContext: overrides.refundContext ?? refundContext,
    policyVersion: REFUND_POLICY_V1.policyVersion,
  });
}

test("creates policy input from proposal intent and authoritative refund facts", () => {
  const input = createInput();

  assert.deepEqual(input, {
    schemaVersion: "1",
    journeyType: "REFUND",
    policyVersion: "refund-policy-v1",
    request: {
      proposalId: "proposal-1",
      orderId: "order-3",
      reasonCode: "DAMAGED",
      scope: "SELECTED_ITEMS",
      itemIds: ["line-1"],
      requestedAmount: { amountMinor: 10_000, currency: "USD" },
    },
    facts: {
      customerVerified: true,
      transactionRefundable: true,
      itemSelectionValid: true,
      refundableAmount: { amountMinor: 10_000, currency: "USD" },
      refundDestination: "ORIGINAL_PAYMENT_METHOD",
    },
    factRefs: [
      {
        factId: "refund-context-1",
        factType: "REFUND_CONTEXT",
        sourceVersion:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        observedAt: "2026-08-06T12:00:00.000Z",
      },
    ],
  });
});

test("rejects trusted facts for a different order", () => {
  assert.throws(
    () =>
      createInput({
        refundContext: {
          ...refundContext,
          source: { ...refundContext.source, orderId: "other-order" },
        },
      }),
    /REFUND_CONTEXT_ORDER_MISMATCH/,
  );
});

test("rejects trusted facts for a different selected item set", () => {
  assert.throws(
    () =>
      createInput({
        refundContext: {
          ...refundContext,
          selection: { scope: "SELECTED_ITEMS", itemIds: ["line-2"] },
        },
      }),
    /REFUND_CONTEXT_SELECTION_MISMATCH/,
  );
});

test("preserves a missing requested amount so policy can request more facts", () => {
  const input = createInput({
    proposal: {
      ...proposal,
      intent: {
        ...proposal.intent,
        requestedAmount: undefined,
      },
    },
  });
  const decision = evaluateRefundPolicy(input, REFUND_POLICY_V1, {
    decisionId: "decision-1",
    decidedAt: "2026-08-06T12:01:00.000Z",
  });

  assert.equal(input.request.requestedAmount, undefined);
  assert.equal(decision.effect, "NEEDS_FACTS");
  assert.deepEqual(decision.missingFacts, ["REQUESTED_AMOUNT", "RISK_CLASS"]);
});
