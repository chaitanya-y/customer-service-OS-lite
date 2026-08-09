import type { RefundContext, RefundProposal } from "./refund-policy-input.js";
import {
  evaluateRefundPolicy,
  type PolicyDecisionContext,
  type RefundPolicyDecision,
} from "./refund-policy.js";
import type { RefundPolicyRelease } from "./refund-policy-release.js";
import { createRefundPolicyInput } from "./refund-policy-input.js";
import type { WorkflowJourneyAccess } from './workflow-access-assertion.js';
import {
  createRefundPreview,
  type RefundPreview,
} from './refund-preview.js';

export type RefreshRefundContextInput = Readonly<{
  proposal: RefundProposal;
  workflowId: string;
  access: WorkflowJourneyAccess;
}>;

export type EvaluateRefundPolicyInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  policyVersion: string;
}>;

export type CreateRefundPreviewActivityInput = Readonly<{
  proposal: RefundProposal;
  refundContext: RefundContext;
  decision: RefundPolicyDecision;
}>;

export type RefundWorkflowActivities = Readonly<{
  refreshRefundContext(
    input: RefreshRefundContextInput,
  ): Promise<RefundContext>;
  evaluateRefundPolicy(
    input: EvaluateRefundPolicyInput,
  ): Promise<RefundPolicyDecision>;
  createRefundPreview(
    input: CreateRefundPreviewActivityInput,
  ): Promise<RefundPreview>;
}>;

type RefundWorkflowActivityDependencies = Readonly<{
  fetchRefundContext(
    input: RefreshRefundContextInput,
  ): Promise<RefundContext>;
  refundPolicyRelease: RefundPolicyRelease;
  createDecisionContext(
    input: EvaluateRefundPolicyInput,
  ): PolicyDecisionContext;
  createPreviewContext(): Readonly<{ previewId: string; createdAt: string }>;
}>;

/**
 * Creates the non-deterministic activity implementations used by Temporal.
 * The worker host supplies the Gateway-backed fact refresh implementation.
 */
export function createRefundWorkflowActivities({
  fetchRefundContext,
  refundPolicyRelease,
  createDecisionContext,
  createPreviewContext,
}: RefundWorkflowActivityDependencies): RefundWorkflowActivities {
  return {
    refreshRefundContext: fetchRefundContext,
    async evaluateRefundPolicy(input) {
      const policyInput = createRefundPolicyInput({
        proposal: input.proposal,
        refundContext: input.refundContext,
        policyVersion: input.policyVersion,
      });

      return evaluateRefundPolicy(
        policyInput,
        refundPolicyRelease,
        createDecisionContext(input),
      );
    },
    async createRefundPreview(input) {
      return createRefundPreview({ ...input, ...createPreviewContext() });
    },
  };
}
