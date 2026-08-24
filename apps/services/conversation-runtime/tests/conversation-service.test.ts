import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConversationService,
  MessageTooLargeError,
} from '../src/conversation-service.js';
import {
  createTestConversationService,
  FakeConversationRepository,
  TEST_CONTEXT,
  TEST_CONVERSATION_ID,
  TEST_MESSAGE_ID,
  TEST_PROTECTED_MESSAGE,
} from './test-fixtures.js';

test('creates a conversation under trusted tenant and customer scope', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.createConversation({
    context: TEST_CONTEXT,
    idempotencyKey: 'create-1',
    channel: 'web',
  });

  assert.deepEqual(result, {
    conversationId: TEST_CONVERSATION_ID,
    status: 'OPEN',
    controlMode: 'AI',
  });
  assert.equal(repository.createRecord?.context, TEST_CONTEXT);
  assert.match(repository.createRecord?.canonicalRequestHash ?? '', /^[a-f0-9]{64}$/);
});

test('prepares an encrypted message record for atomic persistence', async () => {
  const repository = new FakeConversationRepository();
  const service = createTestConversationService(repository);

  const result = await service.acceptMessage({
    context: TEST_CONTEXT,
    conversationId: TEST_CONVERSATION_ID,
    idempotencyKey: 'message-1',
    clientMessageId: 'browser-message-1',
    text: 'Please refund me.',
  });

  assert.deepEqual(result, {
    conversationId: TEST_CONVERSATION_ID,
    messageId: TEST_MESSAGE_ID,
    sequenceNumber: 1,
    status: 'ACCEPTED',
  });
  assert.equal(repository.messageRecord?.context, TEST_CONTEXT);
  assert.equal(
    repository.messageRecord?.protectedMessage,
    TEST_PROTECTED_MESSAGE,
  );
  assert.match(repository.messageRecord?.canonicalRequestHash ?? '', /^[a-f0-9]{64}$/);
});

test('rejects a message larger than 32 KiB before persistence', async () => {
  const repository = new FakeConversationRepository();
  const service = createConversationService({
    repository,
    protectMessage: () => {
      throw new Error('Message should not be encrypted');
    },
  });

  await assert.rejects(
    () =>
      service.acceptMessage({
        context: TEST_CONTEXT,
        conversationId: TEST_CONVERSATION_ID,
        idempotencyKey: 'message-1',
        clientMessageId: 'browser-message-1',
        text: 'a'.repeat(32 * 1_024 + 1),
      }),
    MessageTooLargeError,
  );
  assert.equal(repository.messageRecord, undefined);
});
