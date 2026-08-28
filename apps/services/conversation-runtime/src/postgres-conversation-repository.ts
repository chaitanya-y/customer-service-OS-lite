import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  ConversationUnavailableError,
  IdempotencyConflictError,
  type AcceptMessagePersistenceResult,
  type ConversationRepository,
  type ConversationTranscript,
  type CreateConversationPersistenceResult,
} from './conversation-service.js';
import type { ProtectedMessage, UnprotectMessage } from './message-protection.js';

type IdempotencyRow = QueryResultRow & {
  canonical_request_hash: string;
  result_json: unknown;
};

type ConversationResult = {
  conversationId: string;
};

type MessageResult = {
  messageId: string;
  sequenceNumber: number;
};

type StoredMessageRow = QueryResultRow & {
  message_id: string;
  sequence_number: string;
  sender_kind: 'END_CUSTOMER' | 'ASSISTANT';
  content_length: number;
  content_sha256: string;
  created_at: Date;
  refund_workflow_id: string | null;
  ciphertext: Buffer;
  initialization_vector: Buffer;
  authentication_tag: Buffer;
  encryption_key_version: string;
};

type AppendMessageRecord =
  | Parameters<ConversationRepository['acceptMessage']>[0]
  | Parameters<ConversationRepository['appendAssistantMessage']>[0];

type AppendMessageOptions = {
  operation: 'conversation.accept-message' | 'conversation.append-assistant-message';
  eventType:
    | 'conversation.message.received.v1'
    | 'conversation.assistant-message.committed.v1';
  senderKind: 'END_CUSTOMER' | 'ASSISTANT';
  storedClientMessageId: string;
};

type RefundWorkflowLinkResult = {
  workflowId: string;
};

export class PostgresConversationRepository
  implements ConversationRepository
{
  constructor(
    private readonly pool: Pool,
    private readonly unprotectMessage: UnprotectMessage,
  ) {}

  async checkHealth(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async createConversation(
    record: Parameters<ConversationRepository['createConversation']>[0],
  ): Promise<CreateConversationPersistenceResult> {
    return this.inTransaction(record.context, async (client) => {
      const proposedResult: ConversationResult = {
        conversationId: record.conversationId,
      };
      const inserted = await client.query(
        `
          INSERT INTO events.idempotency_keys (
            tenant_id,
            environment_id,
            operation,
            resource_scope,
            idempotency_key,
            canonical_request_hash,
            result_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
          ON CONFLICT DO NOTHING
          RETURNING idempotency_key
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          'conversation.create',
          record.context.subjectCustomerId,
          record.idempotencyKey,
          record.canonicalRequestHash,
          JSON.stringify(proposedResult),
          record.createdAt,
        ],
      );

      if (inserted.rowCount === 0) {
        const existing = await this.readIdempotencyResult(
          client,
          record.context.tenantId,
          record.context.environmentId,
          'conversation.create',
          record.context.subjectCustomerId,
          record.idempotencyKey,
        );
        ensureMatchingRequest(existing, record.canonicalRequestHash);
        const result = parseConversationResult(existing.result_json);

        return {
          status: 'duplicate',
          conversationId: result.conversationId,
        };
      }

      await client.query(
        `
          INSERT INTO conversation.conversations (
            tenant_id,
            environment_id,
            conversation_id,
            subject_customer_id,
            channel,
            status,
            control_mode,
            next_sequence_number,
            record_version,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'OPEN', 'AI', 1, 1, $6, $6)
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
          record.context.subjectCustomerId,
          record.channel,
          record.createdAt,
        ],
      );

      return {
        status: 'created',
        conversationId: record.conversationId,
      };
    });
  }

  async acceptMessage(
    record: Parameters<ConversationRepository['acceptMessage']>[0],
  ): Promise<AcceptMessagePersistenceResult> {
    return this.appendMessage(record, {
      operation: 'conversation.accept-message',
      eventType: 'conversation.message.received.v1',
      senderKind: 'END_CUSTOMER',
      storedClientMessageId: record.clientMessageId,
    });
  }

  async appendAssistantMessage(
    record: Parameters<ConversationRepository['appendAssistantMessage']>[0],
  ): Promise<AcceptMessagePersistenceResult> {
    return this.appendMessage(record, {
      operation: 'conversation.append-assistant-message',
      eventType: 'conversation.assistant-message.committed.v1',
      senderKind: 'ASSISTANT',
      storedClientMessageId: `assistant:${record.clientMessageId}`,
    });
  }

  async readConversation(
    context: Parameters<ConversationRepository['readConversation']>[0],
    conversationId: string,
  ): Promise<ConversationTranscript> {
    return this.inTransaction(context, async (client) => {
      const conversation = await client.query<{
        status: 'OPEN';
        control_mode: 'AI' | 'QUEUED' | 'HUMAN';
      }>(
        `
          SELECT status, control_mode
          FROM conversation.conversations
          WHERE tenant_id = $1
            AND environment_id = $2
            AND conversation_id = $3
            AND subject_customer_id = $4
        `,
        [
          context.tenantId,
          context.environmentId,
          conversationId,
          context.subjectCustomerId,
        ],
      );

      if (conversation.rowCount !== 1 || !conversation.rows[0]) {
        throw new ConversationUnavailableError();
      }

      const messages = await client.query<StoredMessageRow>(
        `
          SELECT message.message_id,
                 message.sequence_number,
                 message.sender_kind,
                 message.content_length,
                 message.content_sha256,
                 message.created_at,
                 message.refund_workflow_id,
                 payload.ciphertext,
                 payload.initialization_vector,
                 payload.authentication_tag,
                 payload.encryption_key_version
          FROM conversation.messages AS message
          JOIN conversation.message_payloads AS payload
            ON payload.tenant_id = message.tenant_id
           AND payload.environment_id = message.environment_id
           AND payload.payload_id = message.payload_id
          WHERE message.tenant_id = $1
            AND message.environment_id = $2
            AND message.conversation_id = $3
            AND message.status = 'COMMITTED'
            AND message.sender_kind IN ('END_CUSTOMER', 'ASSISTANT')
          ORDER BY message.sequence_number ASC
        `,
        [context.tenantId, context.environmentId, conversationId],
      );

      const storedConversation = conversation.rows[0];
      return {
        conversationId,
        status: storedConversation.status,
        controlMode: storedConversation.control_mode,
        messages: messages.rows.map((message) => ({
          messageId: message.message_id,
          sequenceNumber: Number(message.sequence_number),
          senderKind: message.sender_kind,
          text: this.unprotectMessage(toProtectedMessage(message)),
          createdAt: message.created_at.toISOString(),
          ...(message.refund_workflow_id === null
            ? {}
            : { refundWorkflowId: message.refund_workflow_id }),
        })),
      };
    });
  }

  async linkRefundWorkflow(
    record: Parameters<ConversationRepository['linkRefundWorkflow']>[0],
  ) {
    return this.inTransaction(record.context, async (client) => {
      const existingIdempotency = await this.findIdempotencyResult(
        client,
        record.context.tenantId,
        record.context.environmentId,
        'conversation.link-refund-workflow',
        record.conversationId,
        record.idempotencyKey,
      );
      if (existingIdempotency) {
        ensureMatchingRequest(existingIdempotency, record.canonicalRequestHash);
        const result = parseRefundWorkflowLinkResult(existingIdempotency.result_json);
        return { status: 'duplicate' as const, workflowId: result.workflowId };
      }

      const message = await client.query<{
        subject_customer_id: string;
        refund_workflow_id: string | null;
      }>(
        `
          SELECT conversation.subject_customer_id, message.refund_workflow_id
          FROM conversation.messages AS message
          JOIN conversation.conversations AS conversation
            ON conversation.tenant_id = message.tenant_id
           AND conversation.environment_id = message.environment_id
           AND conversation.conversation_id = message.conversation_id
          WHERE message.tenant_id = $1
            AND message.environment_id = $2
            AND message.conversation_id = $3
            AND message.message_id = $4
            AND message.sender_kind = 'ASSISTANT'
            AND message.status = 'COMMITTED'
          FOR UPDATE
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
          record.messageId,
        ],
      );

      const storedMessage = message.rows[0];
      if (
        message.rowCount !== 1
        || !storedMessage
        || storedMessage.subject_customer_id !== record.context.subjectCustomerId
      ) {
        throw new ConversationUnavailableError();
      }
      if (
        storedMessage.refund_workflow_id !== null
        && storedMessage.refund_workflow_id !== record.workflowId
      ) {
        throw new IdempotencyConflictError();
      }

      if (storedMessage.refund_workflow_id === null) {
        await client.query(
          `
            UPDATE conversation.messages
            SET refund_workflow_id = $5
            WHERE tenant_id = $1
              AND environment_id = $2
              AND conversation_id = $3
              AND message_id = $4
          `,
          [
            record.context.tenantId,
            record.context.environmentId,
            record.conversationId,
            record.messageId,
            record.workflowId,
          ],
        );
      }

      const result: RefundWorkflowLinkResult = { workflowId: record.workflowId };
      await this.insertIdempotencyResult(
        client,
        record,
        'conversation.link-refund-workflow',
        result,
      );

      return {
        status: storedMessage.refund_workflow_id === null
          ? 'linked' as const
          : 'duplicate' as const,
        workflowId: record.workflowId,
      };
    });
  }

  private async appendMessage(
    record: AppendMessageRecord,
    options: AppendMessageOptions,
  ): Promise<AcceptMessagePersistenceResult> {
    return this.inTransaction(record.context, async (client) => {
      const conversation = await client.query<{
        subject_customer_id: string;
      }>(
        `
          SELECT subject_customer_id
          FROM conversation.conversations
          WHERE tenant_id = $1
            AND environment_id = $2
            AND conversation_id = $3
            AND status = 'OPEN'
          FOR UPDATE
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
        ],
      );

      if (
        conversation.rowCount !== 1 ||
        conversation.rows[0]?.subject_customer_id !==
          record.context.subjectCustomerId
      ) {
        throw new ConversationUnavailableError();
      }

      const existingIdempotency = await this.findIdempotencyResult(
        client,
        record.context.tenantId,
        record.context.environmentId,
        options.operation,
        record.conversationId,
        record.idempotencyKey,
      );

      if (existingIdempotency) {
        ensureMatchingRequest(
          existingIdempotency,
          record.canonicalRequestHash,
        );
        const result = parseMessageResult(existingIdempotency.result_json);

        return { status: 'duplicate', ...result };
      }

      const existingClientMessage = await client.query<{
        message_id: string;
        sequence_number: string;
        content_sha256: string;
      }>(
        `
          SELECT message_id, sequence_number, content_sha256
          FROM conversation.messages
          WHERE tenant_id = $1
            AND environment_id = $2
            AND conversation_id = $3
            AND client_message_id = $4
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
          options.storedClientMessageId,
        ],
      );

      if (existingClientMessage.rowCount === 1) {
        const existing = existingClientMessage.rows[0];

        if (
          !existing ||
          existing.content_sha256 !== record.protectedMessage.plaintextSha256
        ) {
          throw new IdempotencyConflictError();
        }

        const result: MessageResult = {
          messageId: existing.message_id,
          sequenceNumber: Number(existing.sequence_number),
        };
        await this.insertIdempotencyResult(
          client,
          record,
          options.operation,
          result,
        );

        return { status: 'duplicate', ...result };
      }

      const allocated = await client.query<{ sequence_number: string }>(
        `
          UPDATE conversation.conversations
          SET next_sequence_number = next_sequence_number + 1,
              record_version = record_version + 1,
              updated_at = $4
          WHERE tenant_id = $1
            AND environment_id = $2
            AND conversation_id = $3
          RETURNING next_sequence_number - 1 AS sequence_number
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
          record.occurredAt,
        ],
      );
      const sequenceNumber = Number(allocated.rows[0]?.sequence_number);

      if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 1) {
        throw new Error('Conversation sequence allocation failed');
      }

      await client.query(
        `
          INSERT INTO conversation.message_payloads (
            tenant_id,
            environment_id,
            payload_id,
            ciphertext,
            initialization_vector,
            authentication_tag,
            encryption_key_version,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.payloadId,
          record.protectedMessage.ciphertext,
          record.protectedMessage.initializationVector,
          record.protectedMessage.authenticationTag,
          record.protectedMessage.encryptionKeyVersion,
          record.occurredAt,
        ],
      );
      await client.query(
        `
          INSERT INTO conversation.messages (
            tenant_id,
            environment_id,
            conversation_id,
            sequence_number,
            message_id,
            client_message_id,
            sender_kind,
            payload_id,
            content_type,
            content_length,
            content_sha256,
            refund_workflow_id,
            status,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                  'text/plain', $9, $10, NULL, 'COMMITTED', $11)
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.conversationId,
          sequenceNumber,
          record.messageId,
          options.storedClientMessageId,
          options.senderKind,
          record.payloadId,
          record.protectedMessage.plaintextByteLength,
          record.protectedMessage.plaintextSha256,
          record.occurredAt,
        ],
      );

      const eventPayload = {
        eventId: record.eventId,
        eventType: options.eventType,
        occurredAt: record.occurredAt.toISOString(),
        producer: 'conversation-runtime',
        tenantId: record.context.tenantId,
        environmentId: record.context.environmentId,
        aggregateType: 'conversation',
        aggregateId: record.conversationId,
        aggregateSequence: sequenceNumber,
        routingEpoch: record.context.routingEpoch,
        traceId: record.context.traceId,
        schemaVersion: 1,
        payload: { messageId: record.messageId },
      };
      await client.query(
        `
          INSERT INTO events.outbox (
            tenant_id,
            environment_id,
            event_id,
            event_type,
            aggregate_type,
            aggregate_id,
            aggregate_sequence,
            routing_epoch,
            trace_id,
            schema_version,
            payload,
            status,
            occurred_at,
            created_at
          )
          VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8,
                  1, $9::jsonb, 'PENDING', $10, $10)
        `,
        [
          record.context.tenantId,
          record.context.environmentId,
          record.eventId,
          options.eventType,
          record.conversationId,
          sequenceNumber,
          record.context.routingEpoch,
          record.context.traceId,
          JSON.stringify(eventPayload),
          record.occurredAt,
        ],
      );

      const result: MessageResult = {
        messageId: record.messageId,
        sequenceNumber,
      };
      await this.insertIdempotencyResult(
        client,
        record,
        options.operation,
        result,
      );

      return { status: 'accepted', ...result };
    });
  }

  private async insertIdempotencyResult(
    client: PoolClient,
    record: AppendMessageRecord | Parameters<ConversationRepository['linkRefundWorkflow']>[0],
    operation: AppendMessageOptions['operation'] | 'conversation.link-refund-workflow',
    result: MessageResult | RefundWorkflowLinkResult,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO events.idempotency_keys (
          tenant_id,
          environment_id,
          operation,
          resource_scope,
          idempotency_key,
          canonical_request_hash,
          result_json,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6,
                $7::jsonb, $8)
      `,
      [
        record.context.tenantId,
        record.context.environmentId,
        operation,
        record.conversationId,
        record.idempotencyKey,
        record.canonicalRequestHash,
        JSON.stringify(result),
        record.occurredAt,
      ],
    );
  }

  private async readIdempotencyResult(
    client: PoolClient,
    tenantId: string,
    environmentId: string,
    operation: string,
    resourceScope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRow> {
    const existing = await this.findIdempotencyResult(
      client,
      tenantId,
      environmentId,
      operation,
      resourceScope,
      idempotencyKey,
    );

    if (!existing) {
      throw new Error('Idempotency record disappeared during transaction');
    }

    return existing;
  }

  private async findIdempotencyResult(
    client: PoolClient,
    tenantId: string,
    environmentId: string,
    operation: string,
    resourceScope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRow | undefined> {
    const result = await client.query<IdempotencyRow>(
      `
        SELECT canonical_request_hash, result_json
        FROM events.idempotency_keys
        WHERE tenant_id = $1
          AND environment_id = $2
          AND operation = $3
          AND resource_scope = $4
          AND idempotency_key = $5
      `,
      [tenantId, environmentId, operation, resourceScope, idempotencyKey],
    );

    return result.rows[0];
  }

  private async inTransaction<T>(
    context: {
      tenantId: string;
      environmentId: string;
      requestId: string;
    },
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(
        `
          SELECT set_config('app.tenant_id', $1, true),
                 set_config('app.environment_id', $2, true),
                 set_config('app.request_id', $3, true)
        `,
        [context.tenantId, context.environmentId, context.requestId],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

function toProtectedMessage(row: StoredMessageRow): ProtectedMessage {
  return {
    ciphertext: row.ciphertext,
    initializationVector: row.initialization_vector,
    authenticationTag: row.authentication_tag,
    plaintextSha256: row.content_sha256,
    plaintextByteLength: row.content_length,
    encryptionKeyVersion: row.encryption_key_version,
  };
}

function ensureMatchingRequest(
  existing: IdempotencyRow,
  canonicalRequestHash: string,
): void {
  if (existing.canonical_request_hash !== canonicalRequestHash) {
    throw new IdempotencyConflictError();
  }
}

function parseConversationResult(value: unknown): ConversationResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('conversationId' in value) ||
    typeof value.conversationId !== 'string'
  ) {
    throw new Error('Stored conversation idempotency result is invalid');
  }

  return { conversationId: value.conversationId };
}

function parseMessageResult(value: unknown): MessageResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('messageId' in value) ||
    typeof value.messageId !== 'string' ||
    !('sequenceNumber' in value) ||
    typeof value.sequenceNumber !== 'number'
  ) {
    throw new Error('Stored message idempotency result is invalid');
  }

  return {
    messageId: value.messageId,
    sequenceNumber: value.sequenceNumber,
  };
}

function parseRefundWorkflowLinkResult(value: unknown): RefundWorkflowLinkResult {
  if (
    typeof value !== 'object'
    || value === null
    || !('workflowId' in value)
    || typeof value.workflowId !== 'string'
  ) {
    throw new Error('Stored refund workflow link result is invalid');
  }

  return { workflowId: value.workflowId };
}
