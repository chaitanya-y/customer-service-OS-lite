import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

export type RefundExecutionStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
export type RefundOperationsSnapshot = Readonly<{
  executionCounts: Readonly<Record<RefundExecutionStatus, number>>;
  oldestExecutionAgeSeconds: Readonly<Partial<Record<'IN_PROGRESS' | 'SUBMITTED' | 'PENDING_RECONCILIATION', number>>>;
  pendingProviderEventCount: number;
  oldestPendingProviderEventAgeSeconds: number;
}>;
export type RefundExecution = Readonly<{ executionId: string; status: RefundExecutionStatus; providerRefundId?: string }>;
export type ReserveRefundExecutionInput = Readonly<{ tenantId: string; environmentId: string; idempotencyKey: string; workflowId: string; previewId: string; orderId: string; amountMinor: number; currency: string; occurredAt: string }>;
export type ProviderRefundOutcome = 'COMPLETED' | 'FAILED';
export type RecordProviderRefundEventInput = Readonly<{
  eventId: string;
  providerRefundId: string;
  outcome: ProviderRefundOutcome;
  occurredAt: string;
}>;
export type PendingProviderRefundEvent = Readonly<{
  eventId: string;
  workflowId: string;
  providerRefundId: string;
  outcome: ProviderRefundOutcome;
  occurredAt: string;
}>;

export interface RefundExecutionRepository {
  reserve(input: ReserveRefundExecutionInput): Promise<{ kind: 'reserved'; executionId: string } | { kind: 'existing'; execution: RefundExecution }>;
  recordOutcome(executionId: string, status: Exclude<RefundExecutionStatus, 'IN_PROGRESS'>, providerRefundId?: string): Promise<RefundExecution>;
  findSucceeded(tenantId: string, environmentId: string, orderId: string, amountMinor: number, currency: string): Promise<RefundExecution | undefined>;
  findByWorkflowAndPreview(tenantId: string, environmentId: string, workflowId: string, previewId: string): Promise<RefundExecution | undefined>;
  recordProviderRefundEvent(input: RecordProviderRefundEventInput): Promise<'ACCEPTED' | 'DUPLICATE' | 'UNKNOWN_REFUND'>;
  listPendingProviderRefundEvents(limit: number): Promise<readonly PendingProviderRefundEvent[]>;
  markProviderRefundEventDelivered(eventId: string): Promise<void>;
  getRefundOperationsSnapshot(): Promise<RefundOperationsSnapshot>;
}

type Row = { execution_id: string; status: RefundExecutionStatus; provider_refund_id: string | null };
function toExecution(row: Row): RefundExecution { return row.provider_refund_id === null ? { executionId: row.execution_id, status: row.status } : { executionId: row.execution_id, status: row.status, providerRefundId: row.provider_refund_id }; }
const activeRefundExecutionStatuses = ['IN_PROGRESS', 'SUBMITTED', 'PENDING_RECONCILIATION'] as const;

function finiteNumber(value: unknown): number {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numberValue)) throw new Error('REFUND_OPERATIONS_SNAPSHOT_INVALID');
  return numberValue;
}

function nonNegativeSafeInteger(value: unknown): number {
  const numberValue = finiteNumber(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new Error('REFUND_OPERATIONS_SNAPSHOT_INVALID');
  return numberValue;
}

function nonNegativeAgeSeconds(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function ageSeconds(now: Date, enteredAt: Date): number {
  return Math.max(0, (now.getTime() - enteredAt.getTime()) / 1_000);
}

export class PostgresRefundExecutionRepository implements RefundExecutionRepository {
  constructor(private readonly pool: Pool) {}
  async reserve(input: ReserveRefundExecutionInput) {
    const executionId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<Row>(`INSERT INTO refund.executions (execution_id, tenant_id, environment_id, idempotency_key, workflow_id, preview_id, order_id, amount_minor, currency, status, created_at, updated_at, status_entered_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IN_PROGRESS',$10,$10,$10) ON CONFLICT (tenant_id, environment_id, idempotency_key) DO NOTHING RETURNING execution_id, status, provider_refund_id`, [executionId, input.tenantId, input.environmentId, input.idempotencyKey, input.workflowId, input.previewId, input.orderId, input.amountMinor, input.currency, input.occurredAt]);
      if (inserted.rowCount === 1) {
        await this.insertAudit(client, executionId, 'refund_execution_requested', { workflowId: input.workflowId, previewId: input.previewId, amountMinor: input.amountMinor, currency: input.currency });
        await client.query('COMMIT');
        return { kind: 'reserved' as const, executionId };
      }
      const existing = await client.query<Row>(`SELECT execution_id, status, provider_refund_id FROM refund.executions WHERE tenant_id = $1 AND environment_id = $2 AND idempotency_key = $3`, [input.tenantId, input.environmentId, input.idempotencyKey]);
      if (existing.rowCount !== 1 || !existing.rows[0]) throw new Error('REFUND_EXECUTION_RESERVATION_FAILED');
      await client.query('COMMIT');
      return { kind: 'existing' as const, execution: toExecution(existing.rows[0]) };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async recordOutcome(executionId: string, status: Exclude<RefundExecutionStatus, 'IN_PROGRESS'>, providerRefundId?: string): Promise<RefundExecution> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Row>(`UPDATE refund.executions SET status = $2, provider_refund_id = COALESCE($3, provider_refund_id), updated_at = now(), status_entered_at = CASE WHEN status IS DISTINCT FROM $2 THEN now() ELSE status_entered_at END WHERE execution_id = $1 RETURNING execution_id, status, provider_refund_id`, [executionId, status, providerRefundId ?? null]);
      if (result.rowCount !== 1 || !result.rows[0]) throw new Error('REFUND_EXECUTION_NOT_FOUND');
      await this.insertAudit(client, executionId, `refund_execution_${status.toLowerCase()}`, { ...(providerRefundId === undefined ? {} : { providerRefundId }) });
      await client.query('COMMIT');
      return toExecution(result.rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async findSucceeded(tenantId: string, environmentId: string, orderId: string, amountMinor: number, currency: string): Promise<RefundExecution | undefined> {
    const result = await this.pool.query<Row>(`SELECT execution_id, status, provider_refund_id FROM refund.executions WHERE tenant_id = $1 AND environment_id = $2 AND order_id = $3 AND amount_minor = $4 AND currency = $5 AND status = 'SUCCEEDED' ORDER BY updated_at DESC LIMIT 1`, [tenantId, environmentId, orderId, amountMinor, currency]);
    return result.rows[0] ? toExecution(result.rows[0]) : undefined;
  }
  async findByWorkflowAndPreview(tenantId: string, environmentId: string, workflowId: string, previewId: string): Promise<RefundExecution | undefined> {
    const result = await this.pool.query<Row>(`SELECT execution_id, status, provider_refund_id FROM refund.executions WHERE tenant_id = $1 AND environment_id = $2 AND workflow_id = $3 AND preview_id = $4 ORDER BY updated_at DESC LIMIT 1`, [tenantId, environmentId, workflowId, previewId]);
    return result.rows[0] ? toExecution(result.rows[0]) : undefined;
  }
  async recordProviderRefundEvent(input: RecordProviderRefundEventInput): Promise<'ACCEPTED' | 'DUPLICATE' | 'UNKNOWN_REFUND'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const duplicate = await client.query('SELECT event_id FROM refund.provider_events WHERE event_id = $1', [input.eventId]);
      if (duplicate.rowCount === 1) {
        await client.query('COMMIT');
        return 'DUPLICATE';
      }
      const execution = await client.query<{ execution_id: string; workflow_id: string; status: RefundExecutionStatus }>(`SELECT execution_id, workflow_id, status FROM refund.executions WHERE provider_refund_id = $1 FOR UPDATE`, [input.providerRefundId]);
      if (execution.rowCount !== 1 || !execution.rows[0]) {
        await client.query('ROLLBACK');
        return 'UNKNOWN_REFUND';
      }
      const row = execution.rows[0];
      const terminalStatus = input.outcome === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED';
      const isAlreadyTerminal = row.status === 'SUCCEEDED' || row.status === 'FAILED';
      if (!isAlreadyTerminal) {
        await client.query(`UPDATE refund.executions SET status = $2, updated_at = now(), status_entered_at = CASE WHEN status IS DISTINCT FROM $2 THEN now() ELSE status_entered_at END WHERE execution_id = $1`, [row.execution_id, terminalStatus]);
        await this.insertAudit(client, row.execution_id, `refund_provider_${input.outcome.toLowerCase()}`, { providerRefundId: input.providerRefundId, eventId: input.eventId });
      }
      await client.query(`INSERT INTO refund.provider_events (event_id, execution_id, provider_refund_id, outcome, occurred_at, delivery_status, delivered_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.eventId, row.execution_id, input.providerRefundId, input.outcome, input.occurredAt, isAlreadyTerminal ? 'DELIVERED' : 'PENDING', isAlreadyTerminal ? input.occurredAt : null]);
      await client.query('COMMIT');
      return 'ACCEPTED';
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async listPendingProviderRefundEvents(limit: number): Promise<readonly PendingProviderRefundEvent[]> {
    const result = await this.pool.query<{
      event_id: string;
      workflow_id: string;
      provider_refund_id: string;
      outcome: ProviderRefundOutcome;
      occurred_at: Date;
    }>(`SELECT event_id, workflow_id, provider_refund_id, outcome, occurred_at FROM refund.provider_events JOIN refund.executions USING (execution_id) WHERE delivery_status = 'PENDING' ORDER BY occurred_at ASC LIMIT $1`, [limit]);
    return result.rows.map((row) => ({ eventId: row.event_id, workflowId: row.workflow_id, providerRefundId: row.provider_refund_id, outcome: row.outcome, occurredAt: row.occurred_at.toISOString() }));
  }
  async markProviderRefundEventDelivered(eventId: string): Promise<void> {
    await this.pool.query(`UPDATE refund.provider_events SET delivery_status = 'DELIVERED', delivered_at = now() WHERE event_id = $1`, [eventId]);
  }
  async getRefundOperationsSnapshot(): Promise<RefundOperationsSnapshot> {
    const result = await this.pool.query<Record<string, unknown>>(`
      WITH execution_snapshot AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'IN_PROGRESS') AS in_progress_count,
          COUNT(*) FILTER (WHERE status = 'SUBMITTED') AS submitted_count,
          COUNT(*) FILTER (WHERE status = 'SUCCEEDED') AS succeeded_count,
          COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_count,
          COUNT(*) FILTER (WHERE status = 'PENDING_RECONCILIATION') AS pending_reconciliation_count,
          EXTRACT(EPOCH FROM statement_timestamp() - MIN(status_entered_at) FILTER (WHERE status = 'IN_PROGRESS')) AS oldest_in_progress_age_seconds,
          EXTRACT(EPOCH FROM statement_timestamp() - MIN(status_entered_at) FILTER (WHERE status = 'SUBMITTED')) AS oldest_submitted_age_seconds,
          EXTRACT(EPOCH FROM statement_timestamp() - MIN(status_entered_at) FILTER (WHERE status = 'PENDING_RECONCILIATION')) AS oldest_pending_reconciliation_age_seconds
        FROM refund.executions
      ), provider_event_snapshot AS (
        SELECT
          COUNT(*) FILTER (WHERE delivery_status = 'PENDING') AS pending_provider_event_count,
          EXTRACT(EPOCH FROM statement_timestamp() - MIN(occurred_at) FILTER (WHERE delivery_status = 'PENDING')) AS oldest_pending_provider_event_age_seconds
        FROM refund.provider_events
      )
      SELECT * FROM execution_snapshot CROSS JOIN provider_event_snapshot
    `);
    const row = result.rows[0];
    if (!row) throw new Error('REFUND_OPERATIONS_SNAPSHOT_INVALID');
    const executionCounts = {
      IN_PROGRESS: nonNegativeSafeInteger(row.in_progress_count),
      SUBMITTED: nonNegativeSafeInteger(row.submitted_count),
      SUCCEEDED: nonNegativeSafeInteger(row.succeeded_count),
      FAILED: nonNegativeSafeInteger(row.failed_count),
      PENDING_RECONCILIATION: nonNegativeSafeInteger(row.pending_reconciliation_count),
    } satisfies Record<RefundExecutionStatus, number>;
    const oldestExecutionAgeSeconds: Partial<Record<(typeof activeRefundExecutionStatuses)[number], number>> = {};
    for (const status of activeRefundExecutionStatuses) {
      if (executionCounts[status] === 0) continue;
      const column = `oldest_${status.toLowerCase()}_age_seconds`;
      oldestExecutionAgeSeconds[status] = nonNegativeAgeSeconds(row[column]);
    }
    const pendingProviderEventCount = nonNegativeSafeInteger(row.pending_provider_event_count);
    return {
      executionCounts,
      oldestExecutionAgeSeconds,
      pendingProviderEventCount,
      oldestPendingProviderEventAgeSeconds: pendingProviderEventCount === 0
        ? 0
        : nonNegativeAgeSeconds(row.oldest_pending_provider_event_age_seconds),
    };
  }
  private async insertAudit(client: PoolClient, executionId: string, eventType: string, details: Record<string, unknown>) { await client.query(`INSERT INTO refund.audit_events (event_id, execution_id, event_type, actor_type, details, occurred_at) VALUES ($1,$2,$3,'WORKFLOW',$4::jsonb,now())`, [randomUUID(), executionId, eventType, JSON.stringify(details)]); }
}

/** Keeps isolated route tests fast. The production server always supplies Postgres. */
export class InMemoryRefundExecutionRepository implements RefundExecutionRepository {
  private readonly executions = new Map<string, { executionId: string; status: RefundExecutionStatus; statusEnteredAt: Date; providerRefundId?: string; key: string; workflowId: string; previewId: string; tenantId: string; environmentId: string; orderId: string; amountMinor: number; currency: string }>();
  private readonly providerEvents = new Map<string, PendingProviderRefundEvent>();
  constructor(private readonly clock: () => Date = () => new Date()) {}
  async reserve(input: ReserveRefundExecutionInput) {
    const key = `${input.tenantId}:${input.environmentId}:${input.idempotencyKey}`;
    const existing = this.executions.get(key);
    if (existing) return { kind: 'existing' as const, execution: this.public(existing) };
    const execution = { executionId: randomUUID(), status: 'IN_PROGRESS' as const, statusEnteredAt: new Date(input.occurredAt), key, workflowId: input.workflowId, previewId: input.previewId, tenantId: input.tenantId, environmentId: input.environmentId, orderId: input.orderId, amountMinor: input.amountMinor, currency: input.currency };
    this.executions.set(key, execution); return { kind: 'reserved' as const, executionId: execution.executionId };
  }
  async recordOutcome(executionId: string, status: Exclude<RefundExecutionStatus, 'IN_PROGRESS'>, providerRefundId?: string) {
    const execution = [...this.executions.values()].find((item) => item.executionId === executionId); if (!execution) throw new Error('REFUND_EXECUTION_NOT_FOUND');
    if (execution.status !== status) {
      execution.status = status;
      execution.statusEnteredAt = this.clock();
    }
    if (providerRefundId !== undefined) execution.providerRefundId = providerRefundId; return this.public(execution);
  }
  async findSucceeded(tenantId: string, environmentId: string, orderId: string, amountMinor: number, currency: string) { const value = [...this.executions.values()].find((item) => item.tenantId === tenantId && item.environmentId === environmentId && item.orderId === orderId && item.amountMinor === amountMinor && item.currency === currency && item.status === 'SUCCEEDED'); return value ? this.public(value) : undefined; }
  async findByWorkflowAndPreview(tenantId: string, environmentId: string, workflowId: string, previewId: string) { const value = [...this.executions.values()].find((item) => item.tenantId === tenantId && item.environmentId === environmentId && item.workflowId === workflowId && item.previewId === previewId); return value ? this.public(value) : undefined; }
  async recordProviderRefundEvent(input: RecordProviderRefundEventInput) {
    if (this.providerEvents.has(input.eventId)) return 'DUPLICATE' as const;
    const execution = [...this.executions.values()].find((item) => item.providerRefundId === input.providerRefundId);
    if (!execution) return 'UNKNOWN_REFUND' as const;
    const isAlreadyTerminal = execution.status === 'SUCCEEDED' || execution.status === 'FAILED';
    if (!isAlreadyTerminal) {
      execution.status = input.outcome === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED';
      execution.statusEnteredAt = this.clock();
    }
    if (!isAlreadyTerminal) this.providerEvents.set(input.eventId, { eventId: input.eventId, workflowId: execution.workflowId, providerRefundId: input.providerRefundId, outcome: input.outcome, occurredAt: input.occurredAt });
    return 'ACCEPTED' as const;
  }
  async listPendingProviderRefundEvents(limit: number) { return [...this.providerEvents.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).slice(0, limit); }
  async markProviderRefundEventDelivered(eventId: string) { this.providerEvents.delete(eventId); }
  async getRefundOperationsSnapshot(): Promise<RefundOperationsSnapshot> {
    const now = this.clock();
    const executionCounts: Record<RefundExecutionStatus, number> = {
      IN_PROGRESS: 0,
      SUBMITTED: 0,
      SUCCEEDED: 0,
      FAILED: 0,
      PENDING_RECONCILIATION: 0,
    };
    const oldestExecutionAgeSeconds: Partial<Record<(typeof activeRefundExecutionStatuses)[number], number>> = {};
    for (const execution of this.executions.values()) {
      executionCounts[execution.status] += 1;
      if (!activeRefundExecutionStatuses.includes(execution.status as (typeof activeRefundExecutionStatuses)[number])) continue;
      const status = execution.status as (typeof activeRefundExecutionStatuses)[number];
      const age = ageSeconds(now, execution.statusEnteredAt);
      oldestExecutionAgeSeconds[status] = Math.max(oldestExecutionAgeSeconds[status] ?? 0, age);
    }
    const pendingProviderEvents = [...this.providerEvents.values()];
    const oldestPendingProviderEventAgeSeconds = pendingProviderEvents.length === 0
      ? 0
      : Math.max(...pendingProviderEvents.map((event) => ageSeconds(now, new Date(event.occurredAt))));
    return { executionCounts, oldestExecutionAgeSeconds, pendingProviderEventCount: pendingProviderEvents.length, oldestPendingProviderEventAgeSeconds };
  }
  private public(value: RefundExecution) { return value.providerRefundId === undefined ? { executionId: value.executionId, status: value.status } : { executionId: value.executionId, status: value.status, providerRefundId: value.providerRefundId }; }
}
