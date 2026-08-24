import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

export type RefundExecutionStatus = 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'PENDING_RECONCILIATION';
export type RefundExecution = Readonly<{ executionId: string; status: RefundExecutionStatus; providerRefundId?: string }>;
export type ReserveRefundExecutionInput = Readonly<{ tenantId: string; environmentId: string; idempotencyKey: string; workflowId: string; previewId: string; orderId: string; amountMinor: number; currency: string; occurredAt: string }>;

export interface RefundExecutionRepository {
  reserve(input: ReserveRefundExecutionInput): Promise<{ kind: 'reserved'; executionId: string } | { kind: 'existing'; execution: RefundExecution }>;
  recordOutcome(executionId: string, status: Exclude<RefundExecutionStatus, 'IN_PROGRESS'>, providerRefundId?: string): Promise<RefundExecution>;
  findSucceeded(tenantId: string, environmentId: string, orderId: string, amountMinor: number, currency: string): Promise<RefundExecution | undefined>;
  findByWorkflowAndPreview(tenantId: string, environmentId: string, workflowId: string, previewId: string): Promise<RefundExecution | undefined>;
}

type Row = { execution_id: string; status: RefundExecutionStatus; provider_refund_id: string | null };
function toExecution(row: Row): RefundExecution { return row.provider_refund_id === null ? { executionId: row.execution_id, status: row.status } : { executionId: row.execution_id, status: row.status, providerRefundId: row.provider_refund_id }; }

export class PostgresRefundExecutionRepository implements RefundExecutionRepository {
  constructor(private readonly pool: Pool) {}
  async reserve(input: ReserveRefundExecutionInput) {
    const executionId = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<Row>(`INSERT INTO refund.executions (execution_id, tenant_id, environment_id, idempotency_key, workflow_id, preview_id, order_id, amount_minor, currency, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'IN_PROGRESS',$10,$10) ON CONFLICT (tenant_id, environment_id, idempotency_key) DO NOTHING RETURNING execution_id, status, provider_refund_id`, [executionId, input.tenantId, input.environmentId, input.idempotencyKey, input.workflowId, input.previewId, input.orderId, input.amountMinor, input.currency, input.occurredAt]);
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
      const result = await client.query<Row>(`UPDATE refund.executions SET status = $2, provider_refund_id = COALESCE($3, provider_refund_id), updated_at = now() WHERE execution_id = $1 RETURNING execution_id, status, provider_refund_id`, [executionId, status, providerRefundId ?? null]);
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
  private async insertAudit(client: PoolClient, executionId: string, eventType: string, details: Record<string, unknown>) { await client.query(`INSERT INTO refund.audit_events (event_id, execution_id, event_type, actor_type, details, occurred_at) VALUES ($1,$2,$3,'WORKFLOW',$4::jsonb,now())`, [randomUUID(), executionId, eventType, JSON.stringify(details)]); }
}

/** Keeps isolated route tests fast. The production server always supplies Postgres. */
export class InMemoryRefundExecutionRepository implements RefundExecutionRepository {
  private readonly executions = new Map<string, { executionId: string; status: RefundExecutionStatus; providerRefundId?: string; key: string; workflowId: string; previewId: string; tenantId: string; environmentId: string; orderId: string; amountMinor: number; currency: string }>();
  async reserve(input: ReserveRefundExecutionInput) {
    const key = `${input.tenantId}:${input.environmentId}:${input.idempotencyKey}`;
    const existing = this.executions.get(key);
    if (existing) return { kind: 'existing' as const, execution: this.public(existing) };
    const execution = { executionId: randomUUID(), status: 'IN_PROGRESS' as const, key, workflowId: input.workflowId, previewId: input.previewId, tenantId: input.tenantId, environmentId: input.environmentId, orderId: input.orderId, amountMinor: input.amountMinor, currency: input.currency };
    this.executions.set(key, execution); return { kind: 'reserved' as const, executionId: execution.executionId };
  }
  async recordOutcome(executionId: string, status: Exclude<RefundExecutionStatus, 'IN_PROGRESS'>, providerRefundId?: string) {
    const execution = [...this.executions.values()].find((item) => item.executionId === executionId); if (!execution) throw new Error('REFUND_EXECUTION_NOT_FOUND');
    execution.status = status; if (providerRefundId !== undefined) execution.providerRefundId = providerRefundId; return this.public(execution);
  }
  async findSucceeded(tenantId: string, environmentId: string, orderId: string, amountMinor: number, currency: string) { const value = [...this.executions.values()].find((item) => item.tenantId === tenantId && item.environmentId === environmentId && item.orderId === orderId && item.amountMinor === amountMinor && item.currency === currency && item.status === 'SUCCEEDED'); return value ? this.public(value) : undefined; }
  async findByWorkflowAndPreview(tenantId: string, environmentId: string, workflowId: string, previewId: string) { const value = [...this.executions.values()].find((item) => item.tenantId === tenantId && item.environmentId === environmentId && item.workflowId === workflowId && item.previewId === previewId); return value ? this.public(value) : undefined; }
  private public(value: RefundExecution) { return value.providerRefundId === undefined ? { executionId: value.executionId, status: value.status } : { executionId: value.executionId, status: value.status, providerRefundId: value.providerRefundId }; }
}
