import {
  createConversationService,
  type AcceptMessagePersistenceResult,
  type ConversationRepository,
  type ConversationTranscript,
  type CreateConversationPersistenceResult,
} from '../src/conversation-service.js';
import type { ProtectedMessage } from '../src/message-protection.js';
import type { ConversationServiceAccessContext } from '../src/service-assertion.js';
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

export const TEST_SERVICE_CONTEXT: ConversationServiceAccessContext = {
  tenantId: 'tenant-local',
  environmentId: 'local',
  subjectCustomerId: 'customer-42',
  routingEpoch: 1,
  requestId: 'edge-request-1',
  traceId: 'edge-trace-1',
};

export const TEST_CONVERSATION_ID = '019c321e-8650-7000-8000-000000000001';
export const TEST_MESSAGE_ID = '019c321e-8650-7000-8000-000000000002';
export const TEST_ASSISTANT_MESSAGE_ID =
  '019c321e-8650-7000-8000-000000000003';

export class FakeConversationRepository implements ConversationRepository {
  createRecord?: Parameters<ConversationRepository['createConversation']>[0];
  messageRecord?: Parameters<ConversationRepository['acceptMessage']>[0];
  assistantMessageRecord?: Parameters<
    ConversationRepository['appendAssistantMessage']
  >[0];
  refundWorkflowLinkRecord?: Parameters<
    ConversationRepository['linkRefundWorkflow']
  >[0];
  createResult: CreateConversationPersistenceResult = {
    status: 'created',
    conversationId: TEST_CONVERSATION_ID,
  };
  messageResult: AcceptMessagePersistenceResult = {
    status: 'accepted',
    messageId: TEST_MESSAGE_ID,
    sequenceNumber: 1,
  };
  assistantMessageResult: AcceptMessagePersistenceResult = {
    status: 'accepted',
    messageId: TEST_ASSISTANT_MESSAGE_ID,
    sequenceNumber: 2,
  };
  refundWorkflowLinkResult = {
    status: 'linked' as const,
    workflowId: 'refund-proposal-001',
  };
  transcript: ConversationTranscript = {
    conversationId: TEST_CONVERSATION_ID,
    status: 'OPEN',
    controlMode: 'AI',
    messages: [
      {
        messageId: TEST_MESSAGE_ID,
        sequenceNumber: 1,
        senderKind: 'END_CUSTOMER',
        text: 'Please refund me.',
        createdAt: '2026-08-05T12:00:00.000Z',
      },
      {
        messageId: TEST_ASSISTANT_MESSAGE_ID,
        sequenceNumber: 2,
        senderKind: 'ASSISTANT',
        text: 'I can help with that.',
        createdAt: '2026-08-05T12:00:01.000Z',
      },
    ],
  };
  createError?: Error;
  messageError?: Error;
  assistantMessageError?: Error;
  transcriptError?: Error;

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

  async appendAssistantMessage(
    record: Parameters<ConversationRepository['appendAssistantMessage']>[0],
  ) {
    this.assistantMessageRecord = record;
    if (this.assistantMessageError) throw this.assistantMessageError;
    return this.assistantMessageResult;
  }

  async linkRefundWorkflow(
    record: Parameters<ConversationRepository['linkRefundWorkflow']>[0],
  ) {
    this.refundWorkflowLinkRecord = record;
    return this.refundWorkflowLinkResult;
  }

  async readConversation(
    _context: Parameters<ConversationRepository['readConversation']>[0],
    _conversationId: string,
  ) {
    if (this.transcriptError) throw this.transcriptError;
    return this.transcript;
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
