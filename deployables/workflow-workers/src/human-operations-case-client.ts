import { z } from 'zod';

import type {
  CloseHumanCaseInput,
  OpenHumanCaseInput,
  OpenHumanCaseResult,
} from './refund-workflow-activities.js';
import type { SignWorkflowAccessAssertion } from './workflow-access-assertion.js';

const WORKFLOW_ASSERTION_HEADER = 'x-cso-workflow-assertion';

const acceptedCaseResponseSchema = z.object({
  refund_case: z.object({ case_id: z.string().min(1) }).passthrough(),
}).passthrough();

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type HumanOperationsCaseClientOptions = Readonly<{
  baseUrl: string;
  signWorkflowAccessAssertion: SignWorkflowAccessAssertion;
  expectedTenantId: string;
  expectedEnvironmentId: string;
  timeoutMilliseconds?: number;
  fetchImpl?: FetchLike;
}>;

export class HumanOperationsUnavailableError extends Error {
  constructor(message = 'Human Operations case request failed') {
    super(message);
    this.name = 'HumanOperationsUnavailableError';
  }
}

/**
 * HTTP-ready boundary for Human Operations. The worker has no fallback client:
 * an unavailable case service must fail the activity, which prevents a human
 * wait state without an actionable queue item.
 */
export function createHumanOperationsCaseClient({
  baseUrl,
  signWorkflowAccessAssertion,
  expectedTenantId,
  expectedEnvironmentId,
  timeoutMilliseconds = 5_000,
  fetchImpl = fetch,
}: HumanOperationsCaseClientOptions): Readonly<{
  openHumanCase(input: OpenHumanCaseInput): Promise<OpenHumanCaseResult>;
  closeHumanCase(input: CloseHumanCaseInput): Promise<void>;
}> {
  const openEndpoint = new URL('/internal/v1/refund-cases', baseUrl);

  function assertScope(input: OpenHumanCaseInput | CloseHumanCaseInput): void {
    if (
      input.access.tenantId !== expectedTenantId ||
      input.access.environmentId !== expectedEnvironmentId
    ) {
      throw new Error('WORKFLOW_ACCESS_SCOPE_MISMATCH');
    }
  }

  async function post(
    endpoint: URL,
    input: OpenHumanCaseInput | CloseHumanCaseInput,
    body: unknown,
    purpose: 'human_case_open' | 'human_case_close',
  ): Promise<z.infer<typeof acceptedCaseResponseSchema>> {
    assertScope(input);
    const assertion = await signWorkflowAccessAssertion({
      workflowId: input.workflowId,
      access: input.access,
      purpose,
    });
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': input.idempotencyKey,
          [WORKFLOW_ASSERTION_HEADER]: assertion,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch {
      throw new HumanOperationsUnavailableError();
    }
    if (!response.ok) {
      throw new HumanOperationsUnavailableError(
        `Human Operations returned ${response.status}`,
      );
    }
    return acceptedCaseResponseSchema.parse(await response.json());
  }

  return {
    async openHumanCase(input) {
      const response = await post(
        openEndpoint,
        input,
        {
          workflow_id: input.workflowId,
          case_type: input.caseType,
          review_packet: toHumanOperationsReviewPacket(input),
          policy_version: input.reviewPacket.policy.policyVersion,
        },
        'human_case_open',
      );
      return { caseId: response.refund_case.case_id };
    },
    async closeHumanCase(input) {
      await post(
        new URL(`/internal/v1/refund-cases/${encodeURIComponent(input.caseId)}/close`, baseUrl),
        input,
        { workflow_id: input.workflowId },
        'human_case_close',
      );
    },
  };
}

/**
 * Human Operations receives a customer-safe display projection, not the
 * workflow's internal proposal/policy object. This keeps its API stable and
 * avoids copying hashes, provider details, or raw customer messages into a
 * staff-facing case.
 */
function toHumanOperationsReviewPacket(input: OpenHumanCaseInput) {
  const { proposal, policy } = input.reviewPacket;

  return {
    ...(input.reviewPacket.orderReference === undefined
      ? {}
      : { order_reference: input.reviewPacket.orderReference }),
    selected_item_ids: [...proposal.itemIds],
    ...(proposal.requestedAmount === undefined
      ? {}
      : {
          requested_amount: {
            amount_minor: proposal.requestedAmount.amountMinor,
            currency: proposal.requestedAmount.currency,
          },
        }),
    refund_reason: proposal.reasonCode,
    policy_reason_codes: [...policy.reasonCodes],
    evidence_ids: policy.factRefs.map((factRef) => factRef.factId),
    policy_version: policy.policyVersion,
  };
}
