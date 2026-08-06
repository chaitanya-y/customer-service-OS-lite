import {
  createConversationService,
  type AcceptMessagePersistenceResult,
  type ConversationRepository,
  type CreateConversationPersistenceResult,
} from '../src/conversation-service.js';
import type { ProtectedMessage } from '../src/message-protection.js';
import type { ConversationAccessContext } from '../src/trusted-context.js';

export const TEST_CONTEXT: ConversationAccessContext = {
  contextId: 'context-1',
  tenantId: 'tenant-local',
  environmentId: 'local',
  subjectCustomerId: 'customer-42',
  routingEpoch: 1,
  requestId: 'request-1',
  traceId: 'trace-1',
};

export const TEST_CONVERSATION_ID = '019c321e-8650-7000-8000-000000000001';
export const TEST_MESSAGE_ID = '019c321e-8650-7000-8000-000000000002';

export class FakeConversationRepository implements ConversationRepository {
  createRecord?: Parameters<ConversationRepository['createConversation']>[0];
  messageRecord?: Parameters<ConversationRepository['acceptMessage']>[0];
  createResult: CreateConversationPersistenceResult = {
    status: 'created',
    conversationId: TEST_CONVERSATION_ID,
  };
  messageResult: AcceptMessagePersistenceResult = {
    status: 'accepted',
    messageId: TEST_MESSAGE_ID,
    sequenceNumber: 1,
  };
  createError?: Error;
  messageError?: Error;

  async createConversation(
    record: Parameters<ConversationRepository['createConversation']>[0],
  ) {
    this.createRecord = record;
    if (this.createError) throw this.createError;
    return this.createResult;
  }

  async acceptMessage(
    record: Parameters<ConversationRepository['acceptMessage']>[0],
  ) {
    this.messageRecord = record;
    if (this.messageError) throw this.messageError;
    return this.messageResult;
  }
}

export const TEST_PROTECTED_MESSAGE: ProtectedMessage = {
  ciphertext: Buffer.from('encrypted'),
  initializationVector: Buffer.alloc(12, 1),
  authenticationTag: Buffer.alloc(16, 2),
  plaintextSha256:
    '66a45e2049392e118f2fa1008f92c434b9b235131206cae6c10615d1c65e24ed',
  plaintextByteLength: 17,
  encryptionKeyVersion: 'test-v1',
};

export function createTestConversationService(
  repository: FakeConversationRepository,
) {
  const ids = [
    TEST_CONVERSATION_ID,
    TEST_MESSAGE_ID,
    '019c321e-8650-7000-8000-000000000003',
    '019c321e-8650-7000-8000-000000000004',
  ];

  return createConversationService({
    repository,
    protectMessage: () => TEST_PROTECTED_MESSAGE,
    createId: () => {
      const id = ids.shift();
      if (!id) throw new Error('Test ID sequence exhausted');
      return id;
    },
    now: () => new Date('2026-08-05T12:00:00.000Z'),
  });
}
