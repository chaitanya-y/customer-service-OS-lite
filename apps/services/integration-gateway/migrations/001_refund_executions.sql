CREATE SCHEMA IF NOT EXISTS refund;

CREATE TABLE refund.executions (
  execution_id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  idempotency_key text NOT NULL,
  workflow_id text NOT NULL,
  preview_id text NOT NULL,
  order_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION')),
  provider_refund_id text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, environment_id, idempotency_key)
);

CREATE TABLE refund.audit_events (
  event_id uuid PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES refund.executions(execution_id),
  event_type text NOT NULL,
  actor_type text NOT NULL,
  details jsonb NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX refund_audit_events_execution_id_occurred_at
  ON refund.audit_events (execution_id, occurred_at);

GRANT USAGE ON SCHEMA refund TO cso_integration_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA refund TO cso_integration_app;
