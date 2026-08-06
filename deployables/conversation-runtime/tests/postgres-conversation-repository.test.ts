import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Pool } from 'pg';

import {
  ConversationUnavailableError,
  createConversationService,
  IdempotencyConflictError,
} from '../src/conversation-service.js';
import { createAesGcmMessageProtector } from '../src/message-protection.js';
import { PostgresConversationRepository } from '../src/postgres-conversation-repository.js';
import type { ConversationAccessContext } from '../src/trusted-context.js';

const databaseUrl = process.env.CONVERSATION_TEST_DATABASE_URL;

test(
  'persists an encrypted message and outbox fact atomically under tenant scope',
  { skip: databaseUrl ? false : 'CONVERSATION_TEST_DATABASE_URL is not set' },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl });
    const repository = new PostgresConversationRepository(pool);
    const service = createConversationService({
      repository,
      protectMessage: createAesGcmMessageProtector({
        key: Buffer.alloc(32, 5),
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
          `,
          [conversation.conversationId],
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
    } finally {
      await pool.end();
    }
  },
);
