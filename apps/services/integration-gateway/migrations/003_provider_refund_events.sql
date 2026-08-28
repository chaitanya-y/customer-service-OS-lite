ALTER TABLE refund.executions
  DROP CONSTRAINT executions_status_check;

ALTER TABLE refund.executions
  ADD CONSTRAINT executions_status_check
  CHECK (status IN ('IN_PROGRESS', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'PENDING_RECONCILIATION'));

CREATE TABLE refund.provider_events (
  event_id text PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES refund.executions(execution_id),
  provider_refund_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('COMPLETED', 'FAILED')),
  occurred_at timestamptz NOT NULL,
  delivery_status text NOT NULL CHECK (delivery_status IN ('PENDING', 'DELIVERED')),
  delivered_at timestamptz
);

CREATE INDEX provider_events_pending_delivery
  ON refund.provider_events (delivery_status, occurred_at);

GRANT SELECT, INSERT, UPDATE ON refund.provider_events TO cso_integration_app;
