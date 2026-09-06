import {
  AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER,
  CONTEXT_ASSERTION_HEADER,
  KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER,
} from './context-assertion.js';

export type RefundIntakeRequest = {
  customer_message: string;
  order_reference?: string;
  conversation_messages?: Array<{
    sequence_number: number;
    text: string;
  }>;
};

export type AgentRuntimeResponse = {
  statusCode: number;
  body: unknown;
};

export type AgentRuntimeContextAssertions = {
  agentRuntime: string;
  integrationGateway: string;
  knowledgeRag: string;
};

export type IntakeRefund = (
  request: RefundIntakeRequest,
  assertions: AgentRuntimeContextAssertions,
) => Promise<AgentRuntimeResponse>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type AgentRuntimeClientOptions = {
  baseUrl: string;
  timeoutMilliseconds?: number;
  fetchImpl?: FetchLike;
};

export class AgentRuntimeUnavailableError extends Error {
  constructor() {
    super('Agent Runtime is unavailable');
    this.name = 'AgentRuntimeUnavailableError';
  }
}

export function createAgentRuntimeClient({
  baseUrl,
  timeoutMilliseconds = 10_000,
  fetchImpl = fetch,
}: AgentRuntimeClientOptions): { intakeRefund: IntakeRefund } {
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new Error('Agent Runtime timeout must be a positive integer');
  }

  const endpoint = new URL('/refunds/intake', baseUrl);

  return {
    async intakeRefund(request, assertions) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [AGENT_RUNTIME_CONTEXT_ASSERTION_HEADER]: assertions.agentRuntime,
            [CONTEXT_ASSERTION_HEADER]: assertions.integrationGateway,
            [KNOWLEDGE_RAG_CONTEXT_ASSERTION_HEADER]: assertions.knowledgeRag,
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMilliseconds),
        });

        return {
          statusCode: response.status,
          body: await response.json(),
        };
      } catch (error) {
        throw new AgentRuntimeUnavailableError();
      }
    },
  };
}
