import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateRefundPolicy,
  type RefundPolicyInput,
} from "../src/refund-policy.js";
import { REFUND_POLICY_V1 } from "../src/refund-policy-release.js";

const decisionContext = {
  decisionId: "policy-decision-001",
  decidedAt: "2026-08-05T15:30:00Z",
} as const;

function makeInput({
  amountMinor = 10_000,
  currency = "USD",
  refundableAmountMinor = 60_000,
  refundableCurrency = currency,
  priorRefundCount = 0,
  refundDestination = "ORIGINAL_PAYMENT_METHOD",
}: {
  amountMinor?: number;
  currency?: string;
  refundableAmountMinor?: number;
  refundableCurrency?: string;
  priorRefundCount?: number;
  refundDestination?:
    | "ORIGINAL_PAYMENT_METHOD"
    | "STORE_CREDIT"
    | "OTHER";
} = {}): RefundPolicyInput {
  return {
    schemaVersion: "1",
    journeyType: "REFUND",
    policyVersion: "refund-policy-v1",
    request: {
      proposalId: "refund-proposal-001",
      orderId: "order-001",
      reasonCode: "DAMAGED",
      scope: "FULL_ORDER",
      itemIds: [],
      requestedAmount: { amountMinor, currency },
    },
    facts: {
      customerVerified: true,
      transactionRefundable: true,
      itemSelectionValid: true,
      priorRefundCount,
      refundableAmount: {
        amountMinor: refundableAmountMinor,
        currency: refundableCurrency,
      },
      refundDestination,
    },
    factRefs: [
      {
        factId: "refund-facts-001",
        factType: "REFUND_CONTEXT",
        sourceVersion:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        observedAt: "2026-08-05T15:29:30Z",
      },
    ],
  };
}

function evaluate(input: RefundPolicyInput) {
  return evaluateRefundPolicy(input, REFUND_POLICY_V1, decisionContext);
}

test("allows exactly $100 under the automatic threshold", () => {
  const decision = evaluate(makeInput({ amountMinor: 10_000 }));

  assert.equal(decision.effect, "ALLOW");
  assert.deepEqual(decision.reasonCodes, [
    "WITHIN_AUTOMATIC_REFUND_THRESHOLD",
  ]);
  assert.deepEqual(decision.obligations, []);
  assert.equal(decision.validUntil, "2026-08-05T15:45:00.000Z");
});

test("requires approval at $100.01", () => {
  const decision = evaluate(makeInput({ amountMinor: 10_001 }));

  assert.equal(decision.effect, "APPROVAL_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "AMOUNT_EXCEEDS_AUTO_APPROVAL_THRESHOLD",
  ]);
  assert.deepEqual(decision.obligations, [
    {
      code: "REQUIRE_HUMAN_APPROVAL",
      parameters: { approvalClass: "REFUND_REVIEW" },
    },
  ]);
});

test("requires approval at exactly $500", () => {
  const decision = evaluate(makeInput({ amountMinor: 50_000 }));

  assert.equal(decision.effect, "APPROVAL_REQUIRED");
});

test("requires takeover at $500.01", () => {
  const decision = evaluate(makeInput({ amountMinor: 50_001 }));

  assert.equal(decision.effect, "TAKEOVER_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "AMOUNT_EXCEEDS_APPROVAL_THRESHOLD",
  ]);
  assert.deepEqual(decision.obligations, [{ code: "REQUIRE_TAKEOVER" }]);
});

test("denies a zero-value refund", () => {
  const decision = evaluate(makeInput({ amountMinor: 0 }));

  assert.equal(decision.effect, "DENY");
  assert.deepEqual(decision.reasonCodes, [
    "REFUND_AMOUNT_MUST_BE_POSITIVE",
  ]);
});

test("denies an amount above the authoritative refundable balance", () => {
  const decision = evaluate(
    makeInput({ amountMinor: 12_001, refundableAmountMinor: 12_000 }),
  );

  assert.equal(decision.effect, "DENY");
  assert.deepEqual(decision.reasonCodes, [
    "REFUND_AMOUNT_EXCEEDS_REFUNDABLE_BALANCE",
  ]);
});

test("returns NEEDS_FACTS instead of guessing", () => {
  const complete = makeInput();
  const input: RefundPolicyInput = {
    ...complete,
    request: {
      proposalId: complete.request.proposalId,
      orderId: complete.request.orderId,
      reasonCode: "UNSPECIFIED",
      scope: "UNSPECIFIED",
      itemIds: [],
    },
    facts: {},
  };

  const decision = evaluate(input);

  assert.equal(decision.effect, "NEEDS_FACTS");
  assert.deepEqual(decision.reasonCodes, ["MISSING_REQUIRED_FACTS"]);
  assert.deepEqual(decision.missingFacts, [
    "CUSTOMER_VERIFICATION",
    "TRANSACTION_REFUNDABILITY",
    "REFUND_REASON",
    "ITEM_SELECTION",
    "REQUESTED_AMOUNT",
    "REFUNDABLE_AMOUNT",
    "REFUND_DESTINATION",
    "PRIOR_REFUND_HISTORY",
  ]);
});

test("routes a non-USD refund to human takeover", () => {
  const decision = evaluate(
    makeInput({ amountMinor: 9_000, currency: "EUR" }),
  );

  assert.equal(decision.effect, "TAKEOVER_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "UNSUPPORTED_CURRENCY_REQUIRES_TAKEOVER",
  ]);
});

test("denies mismatched request and refundable currencies", () => {
  const decision = evaluate(
    makeInput({ currency: "USD", refundableCurrency: "EUR" }),
  );

  assert.equal(decision.effect, "DENY");
  assert.deepEqual(decision.reasonCodes, ["REFUND_CURRENCY_MISMATCH"]);
});

test("elevated risk requires approval even below $100", () => {
  const decision = evaluate(
    makeInput({ amountMinor: 5_000, priorRefundCount: 1 }),
  );

  assert.equal(decision.effect, "APPROVAL_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "ELEVATED_RISK_REQUIRES_APPROVAL",
  ]);
});

test("high risk requires takeover", () => {
  const decision = evaluate(
    makeInput({ amountMinor: 5_000, priorRefundCount: 2 }),
  );

  assert.equal(decision.effect, "TAKEOVER_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "HIGH_RISK_REFUND_REQUIRES_TAKEOVER",
  ]);
});

test("a nonstandard refund destination requires takeover", () => {
  const decision = evaluate(
    makeInput({ refundDestination: "STORE_CREDIT" }),
  );

  assert.equal(decision.effect, "TAKEOVER_REQUIRED");
  assert.deepEqual(decision.reasonCodes, [
    "NON_STANDARD_DESTINATION_REQUIRES_TAKEOVER",
  ]);
});

test("denies an unverified customer", () => {
  const complete = makeInput();
  const decision = evaluate({
    ...complete,
    facts: { ...complete.facts, customerVerified: false },
  });

  assert.equal(decision.effect, "DENY");
  assert.deepEqual(decision.reasonCodes, ["CUSTOMER_NOT_VERIFIED"]);
});

test("denies a reason that is absent from the pinned policy release", () => {
  const complete = makeInput();
  const decision = evaluate({
    ...complete,
    request: { ...complete.request, reasonCode: "UNRECOGNIZED_REASON" },
  });

  assert.equal(decision.effect, "DENY");
  assert.deepEqual(decision.reasonCodes, ["REFUND_REASON_NOT_PERMITTED"]);
});

test("produces identical output for identical facts in any fact-ref order", () => {
  const first = makeInput({ amountMinor: 12_000 });
  const secondFact = {
    factId: "customer-verification-001",
    factType: "CUSTOMER_VERIFICATION",
    sourceVersion: "verification-v1",
    observedAt: "2026-08-05T15:29:00Z",
  } as const;
  const left: RefundPolicyInput = {
    ...first,
    factRefs: [...first.factRefs, secondFact],
  };
  const right: RefundPolicyInput = {
    ...first,
    factRefs: [secondFact, ...first.factRefs],
  };

  assert.deepEqual(evaluate(left), evaluate(right));
});

test("rejects a request pinned to another policy release", () => {
  const input = makeInput();

  assert.throws(
    () => evaluate({ ...input, policyVersion: "refund-policy-v2" }),
    /POLICY_VERSION_MISMATCH/,
  );
});
