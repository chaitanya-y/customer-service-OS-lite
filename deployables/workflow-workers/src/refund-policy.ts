import { createHash } from "node:crypto";

import type { RefundPolicyRelease } from "./refund-policy-release.js";

export type Money = Readonly<{
  amountMinor: number;
  currency: string;
}>;

export type FactRef = Readonly<{
  factId: string;
  factType: string;
  sourceVersion: string;
  observedAt: string;
}>;

export type RefundPolicyInput = Readonly<{
  schemaVersion: "1";
  journeyType: "REFUND";
  policyVersion: string;
  request: Readonly<{
    proposalId: string;
    orderId: string;
    reasonCode: string;
    scope: "FULL_ORDER" | "SELECTED_ITEMS" | "UNSPECIFIED";
    itemIds: readonly string[];
    requestedAmount?: Money;
  }>;
  facts: Readonly<{
    customerVerified?: boolean;
    transactionRefundable?: boolean;
    itemSelectionValid?: boolean;
    refundableAmount?: Money;
    refundDestination?:
      | "ORIGINAL_PAYMENT_METHOD"
      | "STORE_CREDIT"
      | "OTHER";
    riskClass?: "LOW" | "ELEVATED" | "HIGH";
  }>;
  factRefs: readonly FactRef[];
}>;

export type PolicyDecisionContext = Readonly<{
  decisionId: string;
  decidedAt: string;
}>;

export type PolicyEffect =
  | "ALLOW"
  | "APPROVAL_REQUIRED"
  | "TAKEOVER_REQUIRED"
  | "DENY"
  | "NEEDS_FACTS";

export type MissingFact =
  | "REFUND_REASON"
  | "ITEM_SELECTION"
  | "RISK_CLASS"
  | "REQUESTED_AMOUNT"
  | "REFUNDABLE_AMOUNT"
  | "REFUND_DESTINATION"
  | "CUSTOMER_VERIFICATION"
  | "TRANSACTION_REFUNDABILITY";

export type PolicyObligation = Readonly<{
  code:
    | "REQUIRE_HUMAN_APPROVAL"
    | "REQUIRE_TAKEOVER";
  parameters?: Readonly<Record<string, string | number | boolean>>;
}>;

export type RefundPolicyDecision = Readonly<{
  schemaVersion: "1";
  decisionId: string;
  journeyType: "REFUND";
  effect: PolicyEffect;
  policyVersion: string;
  inputFactsHash: string;
  factRefs: readonly FactRef[];
  reasonCodes: readonly string[];
  obligations: readonly PolicyObligation[];
  missingFacts: readonly MissingFact[];
  decidedAt: string;
  validUntil: string;
}>;

export function evaluateRefundPolicy(
  input: RefundPolicyInput,
  release: RefundPolicyRelease,
  context: PolicyDecisionContext,
): RefundPolicyDecision {
  assertPolicyRelease(release);

  if (input.policyVersion !== release.policyVersion) {
    throw new Error("POLICY_VERSION_MISMATCH");
  }

  const decidedAtEpochMilliseconds = Date.parse(context.decidedAt);
  if (Number.isNaN(decidedAtEpochMilliseconds)) {
    throw new Error("INVALID_DECIDED_AT");
  }

  const factRefs = input.factRefs
    .map((factRef) => ({ ...factRef }))
    .sort((left, right) => compareCodePoints(left.factId, right.factId));
  const inputFactsHash = hashPolicyInput({ ...input, factRefs });
  const validUntil = new Date(
    decidedAtEpochMilliseconds + release.decisionValiditySeconds * 1_000,
  ).toISOString();

  const decide = (
    effect: PolicyEffect,
    reasonCodes: readonly string[],
    obligations: readonly PolicyObligation[] = [],
    missingFacts: readonly MissingFact[] = [],
  ): RefundPolicyDecision => ({
    schemaVersion: "1",
    decisionId: context.decisionId,
    journeyType: "REFUND",
    effect,
    policyVersion: release.policyVersion,
    inputFactsHash,
    factRefs,
    reasonCodes,
    obligations,
    missingFacts,
    decidedAt: context.decidedAt,
    validUntil,
  });

  const missingFacts = findMissingFacts(input);
  if (missingFacts.length > 0) {
    return decide(
      "NEEDS_FACTS",
      ["MISSING_REQUIRED_FACTS"],
      [],
      missingFacts,
    );
  }

  const requestedAmount = input.request.requestedAmount;
  const refundableAmount = input.facts.refundableAmount;
  if (requestedAmount === undefined || refundableAmount === undefined) {
    throw new Error("MISSING_AMOUNT_INVARIANT");
  }

  assertMoney(requestedAmount);
  assertMoney(refundableAmount);

  if (input.facts.customerVerified === false) {
    return decide("DENY", ["CUSTOMER_NOT_VERIFIED"]);
  }

  if (input.facts.transactionRefundable === false) {
    return decide("DENY", ["TRANSACTION_NOT_REFUNDABLE"]);
  }

  if (!release.permittedReasonCodes.includes(input.request.reasonCode)) {
    return decide("DENY", ["REFUND_REASON_NOT_PERMITTED"]);
  }

  if (input.facts.itemSelectionValid === false) {
    return decide("DENY", ["ITEM_SELECTION_NOT_REFUNDABLE"]);
  }

  if (requestedAmount.amountMinor === 0) {
    return decide("DENY", ["REFUND_AMOUNT_MUST_BE_POSITIVE"]);
  }

  if (requestedAmount.currency !== refundableAmount.currency) {
    return decide("DENY", ["REFUND_CURRENCY_MISMATCH"]);
  }

  if (requestedAmount.amountMinor > refundableAmount.amountMinor) {
    return decide("DENY", ["REFUND_AMOUNT_EXCEEDS_REFUNDABLE_BALANCE"]);
  }

  const takeoverReasons: string[] = [];
  if (requestedAmount.currency !== release.supportedCurrency) {
    takeoverReasons.push("UNSUPPORTED_CURRENCY_REQUIRES_TAKEOVER");
  }
  if (input.facts.refundDestination !== "ORIGINAL_PAYMENT_METHOD") {
    takeoverReasons.push("NON_STANDARD_DESTINATION_REQUIRES_TAKEOVER");
  }
  if (input.facts.riskClass === "HIGH") {
    takeoverReasons.push("HIGH_RISK_REFUND_REQUIRES_TAKEOVER");
  }
  if (requestedAmount.amountMinor > release.approvalMaximumMinor) {
    takeoverReasons.push("AMOUNT_EXCEEDS_APPROVAL_THRESHOLD");
  }
  if (takeoverReasons.length > 0) {
    return decide(
      "TAKEOVER_REQUIRED",
      takeoverReasons,
      [{ code: "REQUIRE_TAKEOVER" }],
    );
  }

  const approvalReasons: string[] = [];
  if (input.facts.riskClass === "ELEVATED") {
    approvalReasons.push("ELEVATED_RISK_REQUIRES_APPROVAL");
  }
  if (requestedAmount.amountMinor > release.automaticMaximumMinor) {
    approvalReasons.push("AMOUNT_EXCEEDS_AUTO_APPROVAL_THRESHOLD");
  }
  if (approvalReasons.length > 0) {
    return decide(
      "APPROVAL_REQUIRED",
      approvalReasons,
      [
        {
          code: "REQUIRE_HUMAN_APPROVAL",
          parameters: { approvalClass: "REFUND_REVIEW" },
        },
      ],
    );
  }

  return decide("ALLOW", ["WITHIN_AUTOMATIC_REFUND_THRESHOLD"]);
}

function findMissingFacts(input: RefundPolicyInput): MissingFact[] {
  const missingFacts: MissingFact[] = [];

  if (input.facts.customerVerified === undefined) {
    missingFacts.push("CUSTOMER_VERIFICATION");
  }
  if (input.facts.transactionRefundable === undefined) {
    missingFacts.push("TRANSACTION_REFUNDABILITY");
  }
  if (input.request.reasonCode === "UNSPECIFIED") {
    missingFacts.push("REFUND_REASON");
  }
  if (
    input.request.scope === "UNSPECIFIED" ||
    input.facts.itemSelectionValid === undefined
  ) {
    missingFacts.push("ITEM_SELECTION");
  }
  if (input.request.requestedAmount === undefined) {
    missingFacts.push("REQUESTED_AMOUNT");
  }
  if (input.facts.refundableAmount === undefined) {
    missingFacts.push("REFUNDABLE_AMOUNT");
  }
  if (input.facts.refundDestination === undefined) {
    missingFacts.push("REFUND_DESTINATION");
  }
  if (input.facts.riskClass === undefined) {
    missingFacts.push("RISK_CLASS");
  }

  return missingFacts;
}

function assertPolicyRelease(release: RefundPolicyRelease): void {
  if (
    !Number.isSafeInteger(release.automaticMaximumMinor) ||
    !Number.isSafeInteger(release.approvalMaximumMinor) ||
    release.automaticMaximumMinor < 0 ||
    release.approvalMaximumMinor < release.automaticMaximumMinor ||
    !Number.isSafeInteger(release.decisionValiditySeconds) ||
    release.decisionValiditySeconds <= 0 ||
    release.permittedReasonCodes.length === 0
  ) {
    throw new Error("INVALID_POLICY_RELEASE");
  }
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertMoney(money: Money): void {
  if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) {
    throw new Error("INVALID_MONEY_AMOUNT");
  }
}

function hashPolicyInput(input: RefundPolicyInput): string {
  return `sha256:${createHash("sha256")
    .update(canonicalizeJson(input))
    .digest("hex")}`;
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("NON_CANONICAL_POLICY_NUMBER");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
      )
      .join(",")}}`;
  }

  throw new Error("UNSUPPORTED_POLICY_INPUT_VALUE");
}
