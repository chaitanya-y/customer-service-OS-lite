import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import {
  allowedActionsForCaseType,
  type HumanCase,
  type HumanCaseAuditEvent,
  type HumanDecisionOutboxEvent,
  type RefundReviewPacket,
} from './human-case.js';
import {
  HumanCaseRepositoryError,
  type ClaimHumanCaseInput,
  type DecideHumanCaseInput,
  type HumanCaseRepository,
  type OpenHumanCaseInput,
  type ReassignHumanCaseInput,
} from './human-case-repository.js';

type CaseRow = QueryResultRow & {
  case_id: string;
  tenant_id: string;
  environment_id: string;
  workflow_id: string;
  case_type: HumanCase['caseType'];
  status: HumanCase['status'];
  assigned_staff_id: string | null;
  case_version: string;
  review_packet: RefundReviewPacket;
  policy_version: string;
  created_at: Date;
  updated_at: Date;
  decided_at: Date | null;
};

type AuditRow = QueryResultRow & {
  event_id: string;
  case_id: string;
  event_type: HumanCaseAuditEvent['eventType'];
  occurred_at: Date;
  actor_type: HumanCaseAuditEvent['actorType'];
  actor_id: string;
  case_version: string;
  details: Record<string, string>;
};

type OutboxRow = QueryResultRow & {
  event_id: string;
  case_id: string;
  workflow_id: string;
  tenant_id: string;
  environment_id: string;
  decision: HumanDecisionOutboxEvent['decision'];
  decided_by: string;
  decided_at: Date;
  reason_code: string | null;
  note: string | null;
  created_at: Date;
};

type IdempotencyRow = QueryResultRow & {
  request_fingerprint: string;
  outbox_event_id: string | null;
};

type Scope = Readonly<{ tenantId: string; environmentId: string }>;

/**
 * The deployment repository. Every state change, its audit event, and (for a
 * human decision) the durable outbox record live in one PostgreSQL transaction.
 */
export class PostgresHumanCaseRepository implements HumanCaseRepository {
  constructor(private readonly pool: Pool) {}

  async open(input: OpenHumanCaseInput): Promise<HumanCase> {
    return this.inTransaction(input, async (client) => {
      const existing = await client.query<CaseRow>(
        `${caseSelect} WHERE workflow_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() FOR UPDATE`,
        [input.workflowId],
      );
      const current = existing.rows[0];
      if (current) {
        if (current.case_type !== input.caseType || current.policy_version !== input.policyVersion) {
          throw new HumanCaseRepositoryError('CASE_CONFLICT');
        }
        return toHumanCase(current);
      }

      const now = new Date();
      const caseId = `case-${randomUUID()}`;
      const inserted = await client.query<CaseRow>(
        `
          INSERT INTO human_operations.refund_cases (
            tenant_id, environment_id, case_id, workflow_id, case_type, status,
            case_version, review_packet, policy_version, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, 'OPEN', 1, $6::jsonb, $7, $8, $8)
          ON CONFLICT (tenant_id, environment_id, workflow_id) DO NOTHING
          RETURNING *
        `,
        [input.tenantId, input.environmentId, caseId, input.workflowId, input.caseType, JSON.stringify(input.reviewPacket), input.policyVersion, now],
      );
      const created = inserted.rows[0];
      if (!created) {
        const concurrentlyOpened = await client.query<CaseRow>(
          `${caseSelect} WHERE workflow_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`,
          [input.workflowId],
        );
        const currentCase = requiredRow(concurrentlyOpened.rows[0], 'Opened human case disappeared');
        if (currentCase.case_type !== input.caseType || currentCase.policy_version !== input.policyVersion) {
          throw new HumanCaseRepositoryError('CASE_CONFLICT');
        }
        return toHumanCase(currentCase);
      }
      await this.appendAudit(client, created, 'CASE_OPENED', 'WORKFLOW', input.workflowId, { case_type: input.caseType }, now);
      return toHumanCase(created);
    });
  }

  async close(input: Readonly<{ caseId: string; tenantId: string; environmentId: string; workflowId: string }>): Promise<HumanCase> {
    return this.inTransaction(input, async (client) => {
      const current = await this.requireCase(client, input.caseId);
      if (current.workflow_id !== input.workflowId) throw new HumanCaseRepositoryError('CASE_NOT_FOUND');
      if (current.status === 'CLOSED') return toHumanCase(current);
      const now = new Date();
      const result = await client.query<CaseRow>(
        `UPDATE human_operations.refund_cases SET status = 'CLOSED', case_version = case_version + 1, updated_at = $1 WHERE case_id = $2 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() RETURNING *`,
        [now, input.caseId],
      );
      const closed = requiredRow(result.rows[0], 'Closed human case disappeared');
      await this.appendAudit(client, closed, 'CASE_CLOSED', 'WORKFLOW', input.workflowId, {}, now);
      return toHumanCase(closed);
    });
  }

  async list(input: Readonly<{ tenantId: string; environmentId: string; status?: HumanCase['status']; assignee?: 'me' | 'unassigned'; staffId: string }>): Promise<readonly HumanCase[]> {
    return this.inTransaction(input, async (client) => {
      const clauses: string[] = [
        'tenant_id = security.current_tenant_id()',
        'environment_id = security.current_environment_id()',
      ];
      const parameters: unknown[] = [];
      if (input.status !== undefined) {
        parameters.push(input.status);
        clauses.push(`status = $${parameters.length}`);
      }
      if (input.assignee === 'me') {
        parameters.push(input.staffId);
        clauses.push(`assigned_staff_id = $${parameters.length}`);
      } else if (input.assignee === 'unassigned') {
        clauses.push('assigned_staff_id IS NULL');
      }
      const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
      const result = await client.query<CaseRow>(`${caseSelect}${where} ORDER BY updated_at DESC`, parameters);
      return result.rows.map(toHumanCase);
    });
  }

  async get(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<HumanCase> {
    return this.inTransaction(input, async (client) => toHumanCase(await this.requireCase(client, input.caseId)));
  }

  async auditEvents(input: Readonly<{ caseId: string; tenantId: string; environmentId: string }>): Promise<readonly HumanCaseAuditEvent[]> {
    return this.inTransaction(input, async (client) => {
      await this.requireCase(client, input.caseId);
      const result = await client.query<AuditRow>(
        `SELECT event_id, case_id, event_type, occurred_at, actor_type, actor_id, case_version, details
         FROM human_operations.case_audit_events WHERE case_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() ORDER BY occurred_at, event_id`,
        [input.caseId],
      );
      return result.rows.map(toAuditEvent);
    });
  }

  async claim(input: ClaimHumanCaseInput): Promise<HumanCase> {
    return this.inTransaction(input, async (client) => {
      const fingerprint = hash(`claim:${input.expectedCaseVersion}:${input.staffId}`);
      const replay = await this.reserveIdempotency(client, 'claim', input.caseId, input.idempotencyKey, fingerprint);
      if (replay) return toHumanCase(await this.requireCase(client, input.caseId));
      const current = await this.requireCase(client, input.caseId);
      assertExpectedVersion(current, input.expectedCaseVersion);
      if (current.status === 'CLOSED' || current.status === 'DECISION_PENDING' || (current.assigned_staff_id !== null && current.assigned_staff_id !== input.staffId)) {
        throw new HumanCaseRepositoryError('CASE_CONFLICT');
      }
      if (current.assigned_staff_id === input.staffId) return toHumanCase(current);
      const now = new Date();
      const result = await client.query<CaseRow>(
        `UPDATE human_operations.refund_cases SET status = 'CLAIMED', assigned_staff_id = $1, case_version = case_version + 1, updated_at = $2 WHERE case_id = $3 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() RETURNING *`,
        [input.staffId, now, input.caseId],
      );
      const claimed = requiredRow(result.rows[0], 'Claimed human case disappeared');
      await this.appendAudit(client, claimed, 'CASE_CLAIMED', 'HUMAN', input.staffId, {}, now);
      return toHumanCase(claimed);
    });
  }

  async reassign(input: ReassignHumanCaseInput): Promise<HumanCase> {
    return this.inTransaction(input, async (client) => {
      const fingerprint = hash(`reassign:${input.expectedCaseVersion}:${input.assignedStaffId}`);
      const replay = await this.reserveIdempotency(client, 'reassign', input.caseId, input.idempotencyKey, fingerprint);
      if (replay) return toHumanCase(await this.requireCase(client, input.caseId));
      const current = await this.requireCase(client, input.caseId);
      assertExpectedVersion(current, input.expectedCaseVersion);
      if (current.status === 'CLOSED' || current.status === 'DECISION_PENDING') throw new HumanCaseRepositoryError('CASE_CONFLICT');
      const now = new Date();
      const result = await client.query<CaseRow>(
        `UPDATE human_operations.refund_cases SET status = 'CLAIMED', assigned_staff_id = $1, case_version = case_version + 1, updated_at = $2 WHERE case_id = $3 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() RETURNING *`,
        [input.assignedStaffId, now, input.caseId],
      );
      const reassigned = requiredRow(result.rows[0], 'Reassigned human case disappeared');
      await this.appendAudit(client, reassigned, 'CASE_CLAIMED', 'HUMAN', input.assignedStaffId, { reassigned: 'true' }, now);
      return toHumanCase(reassigned);
    });
  }

  async decide(input: DecideHumanCaseInput): Promise<Readonly<{ case: HumanCase; outboxEvent: HumanDecisionOutboxEvent }>> {
    return this.inTransaction(input, async (client) => {
      const fingerprint = hash(`decision:${input.expectedCaseVersion}:${input.staffId}:${input.decision}:${input.reasonCode ?? ''}:${input.note ?? ''}`);
      const replay = await this.reserveIdempotency(client, 'decision', input.caseId, input.idempotencyKey, fingerprint);
      if (replay) {
        if (!replay.outbox_event_id) throw new Error('Decision idempotency result is missing outbox event');
        const event = await this.requireOutboxEvent(client, replay.outbox_event_id);
        return { case: toHumanCase(await this.requireCase(client, input.caseId)), outboxEvent: toOutboxEvent(event) };
      }
      const current = await this.requireCase(client, input.caseId);
      assertExpectedVersion(current, input.expectedCaseVersion);
      if (current.status !== 'CLAIMED' || current.assigned_staff_id !== input.staffId) throw new HumanCaseRepositoryError('CASE_CONFLICT');
      const now = new Date();
      const changed = await client.query<CaseRow>(
        `UPDATE human_operations.refund_cases SET status = 'DECISION_PENDING', decided_at = $1, case_version = case_version + 1, updated_at = $1 WHERE case_id = $2 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() RETURNING *`,
        [now, input.caseId],
      );
      const decided = requiredRow(changed.rows[0], 'Decided human case disappeared');
      const eventId = `outbox-${randomUUID()}`;
      const outbox = await client.query<OutboxRow>(
        `INSERT INTO human_operations.decision_outbox (tenant_id, environment_id, event_id, case_id, workflow_id, decision, decided_by, decided_at, reason_code, note, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $8) RETURNING *`,
        [input.tenantId, input.environmentId, eventId, decided.case_id, decided.workflow_id, input.decision, input.staffId, now, input.reasonCode ?? null, input.note ?? null],
      );
      await client.query(
        `UPDATE human_operations.action_idempotency SET outbox_event_id = $1 WHERE action = 'decision' AND case_id = $2 AND idempotency_key = $3 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`,
        [eventId, input.caseId, input.idempotencyKey],
      );
      await this.appendAudit(client, decided, 'DECISION_RECORDED', 'HUMAN', input.staffId, { decision: input.decision }, now);
      return { case: toHumanCase(decided), outboxEvent: toOutboxEvent(requiredRow(outbox.rows[0], 'Decision outbox event disappeared')) };
    });
  }

  async isOutboxPending(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<boolean> {
    return this.inTransaction(input, async (client) => {
      const result = await client.query<{ status: 'PENDING' | 'DELIVERED' }>(
        `SELECT status FROM human_operations.decision_outbox WHERE event_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`,
        [input.eventId],
      );
      return result.rows[0]?.status === 'PENDING';
    });
  }

  async listPendingOutbox(input: Readonly<{ tenantId: string; environmentId: string; limit: number }>): Promise<readonly HumanDecisionOutboxEvent[]> {
    return this.inTransaction(input, async (client) => {
      const result = await client.query<OutboxRow>(
        `${outboxSelect} WHERE status = 'PENDING' AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() ORDER BY created_at ASC LIMIT $1`,
        [input.limit],
      );
      return result.rows.map(toOutboxEvent);
    });
  }

  async markOutboxDelivered(input: Readonly<{ eventId: string; tenantId: string; environmentId: string }>): Promise<void> {
    await this.inTransaction(input, async (client) => {
      await client.query(
        `UPDATE human_operations.decision_outbox SET status = 'DELIVERED', delivered_at = now() WHERE event_id = $1 AND status = 'PENDING' AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`,
        [input.eventId],
      );
    });
  }

  private async reserveIdempotency(client: PoolClient, action: 'claim' | 'reassign' | 'decision', caseId: string, idempotencyKey: string, fingerprint: string): Promise<IdempotencyRow | undefined> {
    const inserted = await client.query(
      `INSERT INTO human_operations.action_idempotency (tenant_id, environment_id, action, case_id, idempotency_key, request_fingerprint, created_at)
       VALUES (security.current_tenant_id(), security.current_environment_id(), $1, $2, $3, $4, now())
       ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      [action, caseId, idempotencyKey, fingerprint],
    );
    if (inserted.rowCount === 1) return undefined;
    const result = await client.query<IdempotencyRow>(
      `SELECT request_fingerprint, outbox_event_id FROM human_operations.action_idempotency WHERE action = $1 AND case_id = $2 AND idempotency_key = $3 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`,
      [action, caseId, idempotencyKey],
    );
    const existing = requiredRow(result.rows[0], 'Idempotency record disappeared');
    if (existing.request_fingerprint !== fingerprint) throw new HumanCaseRepositoryError('IDEMPOTENCY_CONFLICT');
    return existing;
  }

  private async requireCase(client: PoolClient, caseId: string): Promise<CaseRow> {
    const result = await client.query<CaseRow>(`${caseSelect} WHERE case_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id() FOR UPDATE`, [caseId]);
    const row = result.rows[0];
    if (!row) throw new HumanCaseRepositoryError('CASE_NOT_FOUND');
    return row;
  }

  private async requireOutboxEvent(client: PoolClient, eventId: string): Promise<OutboxRow> {
    const result = await client.query<OutboxRow>(`${outboxSelect} WHERE event_id = $1 AND tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id()`, [eventId]);
    return requiredRow(result.rows[0], 'Decision outbox event disappeared');
  }

  private async appendAudit(client: PoolClient, humanCase: CaseRow, eventType: HumanCaseAuditEvent['eventType'], actorType: HumanCaseAuditEvent['actorType'], actorId: string, details: Record<string, string>, occurredAt: Date): Promise<void> {
    await client.query(
      `INSERT INTO human_operations.case_audit_events (tenant_id, environment_id, event_id, case_id, event_type, occurred_at, actor_type, actor_id, case_version, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
      [humanCase.tenant_id, humanCase.environment_id, `audit-${randomUUID()}`, humanCase.case_id, eventType, occurredAt, actorType, actorId, humanCase.case_version, JSON.stringify(details)],
    );
  }

  private async inTransaction<T>(scope: Scope, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.environment_id', $2, true)`, [scope.tenantId, scope.environmentId]);
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

const caseSelect = `SELECT case_id, tenant_id, environment_id, workflow_id, case_type, status, assigned_staff_id, case_version, review_packet, policy_version, created_at, updated_at, decided_at FROM human_operations.refund_cases`;
const outboxSelect = `SELECT event_id, case_id, workflow_id, tenant_id, environment_id, decision, decided_by, decided_at, reason_code, note, created_at FROM human_operations.decision_outbox`;

function toHumanCase(row: CaseRow): HumanCase {
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    workflowId: row.workflow_id,
    caseType: row.case_type,
    status: row.status,
    allowedActions: allowedActionsForCaseType(row.case_type),
    ...(row.assigned_staff_id === null ? {} : { assignedStaffId: row.assigned_staff_id }),
    caseVersion: Number(row.case_version),
    reviewPacket: row.review_packet,
    policyVersion: row.policy_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
  };
}

function toAuditEvent(row: AuditRow): HumanCaseAuditEvent {
  return { eventId: row.event_id, caseId: row.case_id, eventType: row.event_type, occurredAt: row.occurred_at.toISOString(), actorType: row.actor_type, actorId: row.actor_id, caseVersion: Number(row.case_version), details: row.details };
}

function toOutboxEvent(row: OutboxRow): HumanDecisionOutboxEvent {
  return {
    eventId: row.event_id,
    caseId: row.case_id,
    workflowId: row.workflow_id,
    tenantId: row.tenant_id,
    environmentId: row.environment_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at.toISOString(),
    ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
    ...(row.note === null ? {} : { note: row.note }),
    createdAt: row.created_at.toISOString(),
  };
}

function assertExpectedVersion(row: CaseRow, expected: number): void {
  if (Number(row.case_version) !== expected) throw new HumanCaseRepositoryError('STALE_CASE_VERSION');
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(message);
  return row;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
