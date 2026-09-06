import { WorkflowClient, WorkflowNotFoundError } from '@temporalio/client';

export type RefundWorkflowStartInput = Readonly<{
  workflowId: string;
  orderReference?: string;
  proposal: Readonly<{
    proposalId: string;
    journeyType: 'REFUND';
    intent: Readonly<{
      orderId: string;
      reasonCode: string;
      scope: 'FULL_ORDER' | 'SELECTED_ITEMS';
      itemIds: readonly string[];
      requestedAmount: Readonly<{ amountMinor: number; currency: string }>;
    }>;
  }>;
  policyVersion: string;
  access: Readonly<{
    tenantId: string;
    environmentId: string;
    subjectCustomerId: string;
    requestId: string;
    traceId: string;
  }>;
}>;

export type StartRefundWorkflow = (
  input: RefundWorkflowStartInput,
) => Promise<Readonly<{ workflowId: string }>>;

type WorkflowAccess = RefundWorkflowStartInput['access'];

export type RefundWorkflowView = Readonly<{
  stage: string;
  preview?: Readonly<{
    previewId: string;
    requestedAmount: Readonly<{ amountMinor: number; currency: string }>;
    refundDestination: string;
    validUntil: string;
  }>;
}>;

export type GetRefundWorkflow = (input: Readonly<{
  workflowId: string;
  access: WorkflowAccess;
}>) => Promise<RefundWorkflowView>;

export type ConfirmRefundWorkflow = (input: Readonly<{
  workflowId: string;
  access: WorkflowAccess;
  previewId: string;
  accepted: boolean;
}>) => Promise<void>;

export class RefundWorkflowNotFoundError extends Error {
  constructor() {
    super('Refund workflow was not found for this customer');
    this.name = 'RefundWorkflowNotFoundError';
  }
}

export class RefundPreviewUnavailableError extends Error {
  constructor() {
    super('This refund preview is no longer available for confirmation. Refresh the refund status or start a new request.');
    this.name = 'RefundPreviewUnavailableError';
  }
}

function acceptsConfirmation(workflow: RefundWorkflowView, previewId: string): boolean {
  return workflow.stage === 'AWAITING_CUSTOMER_CONFIRMATION'
    && workflow.preview?.previewId === previewId;
}

export function createTemporalRefundClient({
  client,
  taskQueue,
  now = () => new Date(),
}: Readonly<{
  client: WorkflowClient;
  taskQueue: string;
  now?: () => Date;
}>): {
  startRefundWorkflow: StartRefundWorkflow;
  getRefundWorkflow: GetRefundWorkflow;
  confirmRefundWorkflow: ConfirmRefundWorkflow;
} {
  async function getOwnedHandle(workflowId: string, access: WorkflowAccess) {
    const handle = client.getHandle(workflowId);
    const workflowAccess = await handle.query<WorkflowAccess>('refund.access');
    if (
      workflowAccess.tenantId !== access.tenantId ||
      workflowAccess.environmentId !== access.environmentId ||
      workflowAccess.subjectCustomerId !== access.subjectCustomerId
    ) {
      throw new RefundWorkflowNotFoundError();
    }
    return handle;
  }

  return {
    async startRefundWorkflow(input) {
      const handle = await client.start('refundWorkflow', {
        taskQueue,
        workflowId: input.workflowId,
        args: [{
          ...(input.orderReference === undefined ? {} : { orderReference: input.orderReference }),
          proposal: input.proposal,
          policyVersion: input.policyVersion,
          access: input.access,
        }],
      });

      return { workflowId: handle.workflowId };
    },
    async getRefundWorkflow({ workflowId, access }) {
      const handle = await getOwnedHandle(workflowId, access);
      return handle.query<RefundWorkflowView>('refund.state');
    },
    async confirmRefundWorkflow({ workflowId, access, previewId, accepted }) {
      const handle = await getOwnedHandle(workflowId, access);
      const workflow = await handle.query<RefundWorkflowView>('refund.state');
      if (!acceptsConfirmation(workflow, previewId)) {
        throw new RefundPreviewUnavailableError();
      }

      // This is a status/identity preflight, not an expiry authorization. The
      // workflow clock determines whether the signal arrived before its deadline.
      try {
        await handle.signal('refund.confirmation', {
          previewId,
          accepted,
          confirmedAt: now().toISOString(),
        });
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) {
          // The workflow may have expired after the preflight. Closed workflows
          // remain queryable; only a confirmed state change becomes a conflict.
          const latest = await handle.query<RefundWorkflowView>('refund.state');
          if (!acceptsConfirmation(latest, previewId)) {
            throw new RefundPreviewUnavailableError();
          }
        }
        throw error;
      }
    },
  };
}
