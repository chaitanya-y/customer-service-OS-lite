import { createHash } from 'node:crypto';

import { v7 as uuidv7 } from 'uuid';

import type { ProtectMessage, ProtectedMessage } from './message-protection.js';
import type { ConversationAccessContext } from './trusted-context.js';

export type Conversation = {
  conversationId: string;
  status: 'OPEN';
  controlMode: 'AI';
};

export type AcceptedMessage = {
  conversationId: string;
  messageId: string;
  sequenceNumber: number;
  status: 'ACCEPTED';
};

export type OutboxEvent = {
  eventId: string;
  eventType: 'conversation.message.received.v1';
  occurredAt: Date;
  producer: 'conversation-runtime';
  tenantId: string;
  environmentId: string;
  aggregateType: 'conversation';
  aggregateId: string;
  aggregateSequence: number;
  routingEpoch: number;
  traceId: string;
  schemaVersion: 1;
  payload: {
    messageId: string;
  };
};

type CreateConversationRecord = {
  context: ConversationAccessContext;
  conversationId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  channel: 'web';
  createdAt: Date;
};

type AcceptMessageRecord = {
  context: ConversationAccessContext;
  conversationId: string;
  messageId: string;
  payloadId: string;
  eventId: string;
  idempotencyKey: string;
  canonicalRequestHash: string;
  clientMessageId: string;
  protectedMessage: ProtectedMessage;
  occurredAt: Date;
};

export type CreateConversationPersistenceResult = {
  status: 'created' | 'duplicate';
  conversationId: string;
};

export type AcceptMessagePersistenceResult = {
  status: 'accepted' | 'duplicate';
  messageId: string;
  sequenceNumber: number;
};

export interface ConversationRepository {
  createConversation(
    record: CreateConversationRecord,
  ): Promise<CreateConversationPersistenceResult>;
  acceptMessage(
    record: AcceptMessageRecord,
  ): Promise<AcceptMessagePersistenceResult>;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('The idempotency key was already used for a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export class ConversationUnavailableError extends Error {
  constructor() {
    super('The conversation is unavailable');
    this.name = 'ConversationUnavailableError';
  }
}

export class MessageTooLargeError extends Error {
  constructor() {
    super('Message text must not exceed 32 KiB');
    this.name = 'MessageTooLargeError';
  }
}

type ConversationServiceOptions = {
  repository: ConversationRepository;
  protectMessage: ProtectMessage;
  createId?: () => string;
  now?: () => Date;
};

export type ConversationService = ReturnType<typeof createConversationService>;

export function createConversationService({
  repository,
  protectMessage,
  createId = uuidv7,
  now = () => new Date(),
}: ConversationServiceOptions) {
  return {
    async createConversation(input: {
      context: ConversationAccessContext;
      idempotencyKey: string;
      channel: 'web';
    }): Promise<Conversation> {
      const createdAt = now();
      const result = await repository.createConversation({
        ...input,
        conversationId: createId(),
        canonicalRequestHash: hashCanonicalRequest({
          channel: input.channel,
          subjectCustomerId: input.context.subjectCustomerId,
        }),
        createdAt,
      });

      return {
        conversationId: result.conversationId,
        status: 'OPEN',
        controlMode: 'AI',
      };
    },

    async acceptMessage(input: {
      context: ConversationAccessContext;
      conversationId: string;
      idempotencyKey: string;
      clientMessageId: string;
      text: string;
    }): Promise<AcceptedMessage> {
      if (Buffer.byteLength(input.text, 'utf8') > 32 * 1_024) {
        throw new MessageTooLargeError();
      }

      const occurredAt = now();
      const result = await repository.acceptMessage({
        context: input.context,
        conversationId: input.conversationId,
        messageId: createId(),
        payloadId: createId(),
        eventId: createId(),
        idempotencyKey: input.idempotencyKey,
        canonicalRequestHash: hashCanonicalRequest({
          clientMessageId: input.clientMessageId,
          text: input.text,
        }),
        clientMessageId: input.clientMessageId,
        protectedMessage: protectMessage(input.text),
        occurredAt,
      });

      return {
        conversationId: input.conversationId,
        messageId: result.messageId,
        sequenceNumber: result.sequenceNumber,
        status: 'ACCEPTED',
      };
    },
  };
}

function hashCanonicalRequest(value: Record<string, string>): string {
  const canonicalValue = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );

  return createHash('sha256')
    .update(JSON.stringify(canonicalValue))
    .digest('hex');
}
