CREATE INDEX decision_outbox_pending_observation_by_scope_and_age
ON human_operations.decision_outbox (tenant_id, environment_id, created_at)
WHERE status = 'PENDING';
