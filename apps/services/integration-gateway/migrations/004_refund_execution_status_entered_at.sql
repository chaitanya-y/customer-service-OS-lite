ALTER TABLE refund.executions
  ADD COLUMN status_entered_at timestamptz;

UPDATE refund.executions
  SET status_entered_at = updated_at
  WHERE status_entered_at IS NULL;

ALTER TABLE refund.executions
  ALTER COLUMN status_entered_at SET NOT NULL;

CREATE INDEX refund_executions_status_entered_at
  ON refund.executions (status, status_entered_at);
