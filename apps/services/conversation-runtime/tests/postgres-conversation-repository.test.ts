import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import {
  ConversationUnavailableError,
  createConversationService,
  IdempotencyConflictError,
} from '../src/conversation-service.js';
import {
  createAesGcmMessageProtector,
  createAesGcmMessageUnprotector,
} from '../src/message-protection.js';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';
import type { ConversationAccessContext } from '../src/trusted-context.js';

const databaseUrl = process.env.CONVERSATION_TEST_DATABASE_URL;

test(
  'persists an encrypted message and outbox fact atomically under tenant scope',
  { skip: databaseUrl ? false : 'CONVERSATION_TEST_DATABASE_URL is not set' },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const encryptionKey = Buffer.alloc(32, 5);
    const repository = new PostgresConversationRepository(
      pool,
      createAesGcmMessageUnprotector({
        key: encryptionKey,
        keyVersion: 'integration-test-v1',
      }),
    );
    const service = createConversationService({
      repository,
      protectMessage: createAesGcmMessageProtector({
        key: encryptionKey,
        keyVersion: 'integration-test-v1',
      }),
    });
    const unique = Date.now().toString(36);
    const context: ConversationAccessContext = {
      contextId: `context-${unique}`,
      tenantId: `tenant-${unique}`,
      environmentId: 'integration-test',
      subjectCustomerId: `customer-${unique}`,
      routingEpoch: 7,
      requestId: `request-${unique}`,
      traceId: `trace-${unique}`,
    };

    try {
      const conversation = await service.createConversation({
        context,
        idempotencyKey: `create-${unique}`,
        channel: 'web',
      });
      const accepted = await service.acceptMessage({
        context,
        conversationId: conversation.conversationId,
        idempotencyKey: `message-${unique}`,
        clientMessageId: `browser-${unique}`,
        text: 'Please refund my order.',
      });
      const duplicate = await service.acceptMessage({
        context,
        conversationId: conversation.conversationId,
        idempotencyKey: `message-${unique}`,
        clientMessageId: `browser-${unique}`,
        text: 'Please refund my order.',
      });

      assert.equal(duplicate.messageId, accepted.messageId);
      assert.equal(duplicate.sequenceNumber, accepted.sequenceNumber);
      const assistantContext = {
        tenantId: context.tenantId,
        environmentId: context.environmentId,
        subjectCustomerId: context.subjectCustomerId,
        routingEpoch: context.routingEpoch,
        requestId: `edge-${unique}`,
        traceId: `edge-trace-${unique}`,
      };
      const assistant = await service.appendAssistantMessage({
        context: assistantContext,
        conversationId: conversation.conversationId,
        idempotencyKey: `assistant-${unique}`,
        clientMessageId: `agent-turn-${unique}`,
        text: 'I can help with that.',
      });
      const duplicateAssistant = await service.appendAssistantMessage({
        context: assistantContext,
        conversationId: conversation.conversationId,
        idempotencyKey: `assistant-${unique}`,
        clientMessageId: `agent-turn-${unique}`,
        text: 'I can help with that.',
      });

      assert.equal(assistant.sequenceNumber, accepted.sequenceNumber + 1);
      assert.equal(duplicateAssistant.messageId, assistant.messageId);
      assert.equal(duplicateAssistant.sequenceNumber, assistant.sequenceNumber);
      const workflowLink = await service.linkRefundWorkflow({
        context: assistantContext,
        conversationId: conversation.conversationId,
        messageId: assistant.messageId,
        workflowId: `refund-${unique}`,
        idempotencyKey: `assistant-workflow-${unique}`,
      });
      const duplicateWorkflowLink = await service.linkRefundWorkflow({
        context: assistantContext,
        conversationId: conversation.conversationId,
        messageId: assistant.messageId,
        workflowId: `refund-${unique}`,
        idempotencyKey: `assistant-workflow-${unique}`,
      });
      assert.equal(workflowLink.workflowId, `refund-${unique}`);
      assert.equal(duplicateWorkflowLink.workflowId, `refund-${unique}`);
      await assert.rejects(
        () =>
          service.acceptMessage({
            context,
            conversationId: conversation.conversationId,
            idempotencyKey: `message-${unique}`,
            clientMessageId: `browser-${unique}`,
            text: 'A different request.',
          }),
        IdempotencyConflictError,
      );

      const unscopedMessages = await pool.query(
        'SELECT message_id FROM conversation.messages',
      );
      assert.equal(unscopedMessages.rowCount, 0);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `
            SELECT set_config('app.tenant_id', $1, true),
                   set_config('app.environment_id', $2, true)
          `,
          [context.tenantId, context.environmentId],
        );
        const stored = await client.query<{
          ciphertext: Buffer;
          event_payload: unknown;
          routing_epoch: string;
        }>(
          `
            SELECT payload.ciphertext,
                   outbox.payload AS event_payload,
                   outbox.routing_epoch
            FROM conversation.messages AS message
            JOIN conversation.message_payloads AS payload
              USING (tenant_id, environment_id, payload_id)
            JOIN events.outbox AS outbox
              ON outbox.tenant_id = message.tenant_id
             AND outbox.environment_id = message.environment_id
             AND outbox.aggregate_id = message.conversation_id
             AND outbox.aggregate_sequence = message.sequence_number
            WHERE message.conversation_id = $1
              AND message.sequence_number = $2
          `,
          [conversation.conversationId, accepted.sequenceNumber],
        );
        assert.equal(stored.rowCount, 1);
        assert.equal(
          stored.rows[0]?.ciphertext.includes(
            Buffer.from('Please refund my order.'),
          ),
          false,
        );
        assert.equal(
          JSON.stringify(stored.rows[0]?.event_payload).includes(
            'Please refund my order.',
          ),
          false,
        );
        assert.equal(stored.rows[0]?.routing_epoch, '7');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const transcript = await service.getConversation({
        context,
        conversationId: conversation.conversationId,
      });
      assert.deepEqual(
        transcript.messages.map((message) => ({
          senderKind: message.senderKind,
          text: message.text,
          ...(message.refundWorkflowId === undefined
            ? {}
            : { refundWorkflowId: message.refundWorkflowId }),
        })),
        [
          { senderKind: 'END_CUSTOMER', text: 'Please refund my order.' },
          {
            senderKind: 'ASSISTANT',
            text: 'I can help with that.',
            refundWorkflowId: `refund-${unique}`,
          },
        ],
      );

      await assert.rejects(
        () =>
          service.acceptMessage({
            context: { ...context, tenantId: `another-${unique}` },
            conversationId: conversation.conversationId,
            idempotencyKey: `other-${unique}`,
            clientMessageId: `other-${unique}`,
            text: 'Cross-tenant attempt.',
          }),
        ConversationUnavailableError,
      );
      await assert.rejects(
        () =>
          service.getConversation({
            context: { ...context, subjectCustomerId: `other-${unique}` },
            conversationId: conversation.conversationId,
          }),
        ConversationUnavailableError,
      );
    } finally {
      await pool.end();
    }
  },
);
