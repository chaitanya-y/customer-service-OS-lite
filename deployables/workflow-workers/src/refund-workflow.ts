import {
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

import type { RefundWorkflowActivities } from "./refund-workflow-activities.js";
import type { RefundProposal } from "./refund-policy-input.js";
import type { RefundPolicyDecision } from "./refund-policy.js";
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import type { RefundPreview } from './refund-preview.js';

const activities = proxyActivities<RefundWorkflowActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export type RefundWorkflowRequest = Readonly<{
  proposal: RefundProposal;
  policyVersion: string;
  access: WorkflowJourneyAccess;
}>;

export type RefundCustomerConfirmation = Readonly<{
  previewId: string;
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
  preview?: RefundPreview;
}>;

export const confirmRefund = defineSignal<[RefundCustomerConfirmation]>(
  "refund.confirmation",
);

export const getRefundWorkflowState = defineQuery<RefundWorkflowState>(
  "refund.state",
);
export const getRefundWorkflowAccess = defineQuery<WorkflowJourneyAccess>(
  "refund.access",
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
  setHandler(getRefundWorkflowAccess, () => request.access);

  const refundContext = await activities.refreshRefundContext({
    proposal: request.proposal,
    workflowId: workflowInfo().workflowId,
    access: request.access,
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
      {
        const preview = await activities.createRefundPreview({
          proposal: request.proposal,
          refundContext,
          decision,
        });
        state = {
          stage: "AWAITING_CUSTOMER_CONFIRMATION",
          decision,
          preview,
        };
        setHandler(confirmRefund, (receivedConfirmation) => {
          if (
            confirmation === undefined &&
            receivedConfirmation.previewId === preview.previewId
          ) {
            confirmation = receivedConfirmation;
          }
        });
        await condition(() => confirmation?.previewId === preview.previewId);
        if (confirmation === undefined) {
          throw new Error("REFUND_CONFIRMATION_INVARIANT");
        }
        state = {
          stage: confirmation.accepted ? "CONFIRMED" : "CANCELLED",
          decision,
          preview,
        };
        return state;
      }
  }
}
