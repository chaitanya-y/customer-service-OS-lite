import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import type { RefundWorkflowActivities } from "./refund-workflow-activities.js";
import type { RefundProposal } from "./refund-policy-input.js";
import type { RefundPolicyDecision } from "./refund-policy.js";

const activities = proxyActivities<RefundWorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export type RefundWorkflowRequest = Readonly<{
  proposal: RefundProposal;
  policyVersion: string;
}>;

export type RefundCustomerConfirmation = Readonly<{
  accepted: boolean;
  confirmedAt: string;
}>;

export type RefundWorkflowState = Readonly<{
  stage:
    | "EVALUATING"
    | "AWAITING_CUSTOMER_CONFIRMATION"
    | "CONFIRMED"
    | "CANCELLED"
    | "NEEDS_FACTS"
    | "DENIED"
    | "AWAITING_APPROVAL"
    | "HUMAN_TAKEOVER_REQUIRED";
  decision?: RefundPolicyDecision;
}>;

export const confirmRefund = defineSignal<[RefundCustomerConfirmation]>(
  "refund.confirmation",
);

export const getRefundWorkflowState = defineQuery<RefundWorkflowState>(
  "refund.state",
);

/**
 * Coordinates a refund journey. It does not decide eligibility or issue a
 * refund; those responsibilities remain in policy activities and future
 * authorized-action activities respectively.
 */
export async function refundWorkflow(
  request: RefundWorkflowRequest,
): Promise<RefundWorkflowState> {
  let state: RefundWorkflowState = { stage: "EVALUATING" };
  let confirmation: RefundCustomerConfirmation | undefined;

  setHandler(getRefundWorkflowState, () => state);
  setHandler(confirmRefund, (receivedConfirmation) => {
    if (confirmation === undefined) {
      confirmation = receivedConfirmation;
    }
  });

  const refundContext = await activities.refreshRefundContext({
    proposal: request.proposal,
  });
  const decision = await activities.evaluateRefundPolicy({
    proposal: request.proposal,
    refundContext,
    policyVersion: request.policyVersion,
  });

  switch (decision.effect) {
    case "NEEDS_FACTS":
      state = { stage: "NEEDS_FACTS", decision };
      return state;
    case "DENY":
      state = { stage: "DENIED", decision };
      return state;
    case "APPROVAL_REQUIRED":
      state = { stage: "AWAITING_APPROVAL", decision };
      return state;
    case "TAKEOVER_REQUIRED":
      state = { stage: "HUMAN_TAKEOVER_REQUIRED", decision };
      return state;
    case "ALLOW":
      state = { stage: "AWAITING_CUSTOMER_CONFIRMATION", decision };
      await condition(() => confirmation !== undefined);
      if (confirmation === undefined) {
        throw new Error("REFUND_CONFIRMATION_INVARIANT");
      }
      state = {
        stage: confirmation.accepted ? "CONFIRMED" : "CANCELLED",
        decision,
      };
      return state;
  }
}
