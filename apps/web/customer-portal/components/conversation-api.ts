import { getApiErrorMessage } from "./customer-api";

export type CustomerChatMessage = Readonly<{
  createdAt?: string;
  messageId: string;
  refundWorkflow?: RefundWorkflowLink;
  sender: "assistant" | "customer";
  text: string;
}>;

export type CustomerConversation = Readonly<{
  conversationId: string;
  messages: readonly CustomerChatMessage[];
}>;

export type RefundWorkflowLink = Readonly<{
  workflowId: string;
}>;

export type CustomerConversationTurn = Readonly<{
  assistantMessage?: CustomerChatMessage;
  conversationId: string;
  customerMessageId: string;
  refundWorkflow?: RefundWorkflowLink;
}>;

type UnknownRecord = Record<string, unknown>;

const MAX_CUSTOMER_MESSAGE_LENGTH = 2_000;
const MAX_SAFE_TEXT_LENGTH = 8_000;

export class CustomerConversationApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CustomerConversationApiError";
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, maxLength = MAX_SAFE_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function asIdentifier(value: unknown): string | undefined {
  const identifier = asText(value, 200);
  return identifier && /^[a-zA-Z0-9_-]+$/.test(identifier) ? identifier : undefined;
}

function asData(value: unknown): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.data) ? value.data : value;
}

function asMessageText(value: UnknownRecord): string | undefined {
  const content = isRecord(value.content) ? value.content : undefined;
  const contentType = asText(content?.type, 32);

  if (content && contentType === "text") return asText(content.text);
  return asText(value.text);
}

function asMessageSender(value: unknown): CustomerChatMessage["sender"] | undefined {
  const sender = asText(value, 48)?.toLowerCase();

  if (
    sender === "customer"
    || sender === "customer_message"
    || sender === "end_customer"
  ) return "customer";
  if (sender === "assistant" || sender === "assistant_message") return "assistant";
  return undefined;
}

function normalizeTranscriptMessage(value: unknown): CustomerChatMessage | undefined {
  if (!isRecord(value)) return undefined;

  const messageId = asIdentifier(value.message_id) ?? asIdentifier(value.messageId);
  const sender = asMessageSender(value.sender_kind) ?? asMessageSender(value.senderKind);
  const text = asMessageText(value);
  const createdAt = asText(value.created_at, 100) ?? asText(value.createdAt, 100);
  const workflow = isRecord(value.refund_workflow) ? value.refund_workflow : undefined;
  const workflowId = asIdentifier(workflow?.workflow_id) ?? asIdentifier(workflow?.workflowId);

  if (!messageId || !sender || !text) return undefined;
  return {
    messageId,
    sender,
    text,
    ...(createdAt ? { createdAt } : {}),
    ...(workflowId && sender === "assistant" ? { refundWorkflow: { workflowId } } : {}),
  };
}

function normalizeAssistantMessage(
  value: unknown,
  fallbackMessageId: string,
): CustomerChatMessage | undefined {
  if (!isRecord(value)) return undefined;

  const text = asMessageText(value);
  if (!text) return undefined;

  const messageId = asIdentifier(value.message_id) ?? asIdentifier(value.messageId) ?? fallbackMessageId;
  const createdAt = asText(value.created_at, 100) ?? asText(value.createdAt, 100);
  return { messageId, sender: "assistant", text, ...(createdAt ? { createdAt } : {}) };
}

function parseConversationId(value: UnknownRecord): string {
  const conversationId = asIdentifier(value.conversation_id) ?? asIdentifier(value.conversationId);
  if (!conversationId) throw new Error("The conversation response was not valid.");
  return conversationId;
}

function parseResponseBody(value: unknown): UnknownRecord {
  const payload = asData(value);
  if (!payload) throw new Error("The support service returned an invalid response.");
  return payload;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  return response.json().catch(() => undefined);
}

export function parseCustomerConversation(payload: unknown): CustomerConversation {
  const data = parseResponseBody(payload);
  const conversationId = parseConversationId(data);
  const messages = Array.isArray(data.messages)
    ? data.messages.flatMap((message) => {
      const normalized = normalizeTranscriptMessage(message);
      return normalized ? [normalized] : [];
    })
    : [];

  return { conversationId, messages };
}

export function parseCustomerConversationCreated(payload: unknown): CustomerConversation {
  const data = parseResponseBody(payload);
  return { conversationId: parseConversationId(data), messages: [] };
}

export function parseCustomerConversationTurn(payload: unknown): CustomerConversationTurn {
  const data = parseResponseBody(payload);
  const conversationId = parseConversationId(data);
  const customerMessageId = asIdentifier(data.customer_message_id) ?? asIdentifier(data.customerMessageId);
  if (!customerMessageId) throw new Error("The support service did not confirm your message.");

  const workflow = isRecord(data.refund_workflow) ? data.refund_workflow : undefined;
  const workflowId = asIdentifier(workflow?.workflow_id) ?? asIdentifier(workflow?.workflowId);
  const assistantMessage = normalizeAssistantMessage(
    data.assistant_message ?? data.assistantMessage,
    `assistant-${customerMessageId}`,
  );

  return {
    conversationId,
    customerMessageId,
    ...(assistantMessage ? { assistantMessage } : {}),
    ...(workflowId ? { refundWorkflow: { workflowId } } : {}),
  };
}

export async function createCustomerConversation(idempotencyKey: string): Promise<CustomerConversation> {
  const response = await fetch("/api/conversations", {
    body: "{}",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    method: "POST",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not start a support conversation. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversationCreated(body);
}

export async function loadCustomerConversation(conversationId: string): Promise<CustomerConversation> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
    cache: "no-store",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not load this conversation. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversation(body);
}

export async function sendCustomerMessage(input: Readonly<{
  clientMessageId: string;
  conversationId: string;
  idempotencyKey: string;
  orderReference?: string;
  text: string;
}>): Promise<CustomerConversationTurn> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}/messages`, {
    body: JSON.stringify({
      client_message_id: input.clientMessageId,
      content: { type: "text", text: input.text },
      ...(input.orderReference ? { order_reference: input.orderReference } : {}),
    }),
    headers: {
      "content-type": "application/json",
      "idempotency-key": input.idempotencyKey,
    },
    method: "POST",
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CustomerConversationApiError(
      getApiErrorMessage(body, "We could not send your message. Please try again."),
      response.status,
    );
  }
  return parseCustomerConversationTurn(body);
}

export function isValidCustomerMessage(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= MAX_CUSTOMER_MESSAGE_LENGTH;
}

export { MAX_CUSTOMER_MESSAGE_LENGTH };
