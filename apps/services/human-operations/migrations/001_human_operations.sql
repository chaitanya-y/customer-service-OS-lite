CREATE SCHEMA IF NOT EXISTS security;
CREATE SCHEMA IF NOT EXISTS human_operations;

CREATE OR REPLACE FUNCTION security.current_tenant_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION security.current_environment_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('app.environment_id', true), '')
$$;

CREATE TABLE human_operations.refund_cases (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  case_id text NOT NULL,
  workflow_id text NOT NULL,
  case_type text NOT NULL CHECK (case_type IN ('REFUND_APPROVAL', 'REFUND_TAKEOVER')),
  status text NOT NULL CHECK (status IN ('OPEN', 'CLAIMED', 'DECISION_PENDING', 'CLOSED')),
  assigned_staff_id text,
  case_version bigint NOT NULL CHECK (case_version >= 1),
  review_packet jsonb NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  decided_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, case_id),
  UNIQUE (tenant_id, environment_id, workflow_id)
);

CREATE TABLE human_operations.case_audit_events (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  event_id text NOT NULL,
  case_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('CASE_OPENED', 'CASE_CLAIMED', 'DECISION_RECORDED', 'CASE_CLOSED')),
  occurred_at timestamptz NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('WORKFLOW', 'HUMAN')),
  actor_id text NOT NULL,
  case_version bigint NOT NULL CHECK (case_version >= 1),
  details jsonb NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, event_id),
  FOREIGN KEY (tenant_id, environment_id, case_id)
    REFERENCES human_operations.refund_cases (tenant_id, environment_id, case_id)
);

CREATE TABLE human_operations.action_idempotency (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('claim', 'reassign', 'decision')),
  case_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  outbox_event_id text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, environment_id, action, case_id, idempotency_key)
);

CREATE TABLE human_operations.decision_outbox (
  tenant_id text NOT NULL,
  environment_id text NOT NULL,
  event_id text NOT NULL,
  case_id text NOT NULL,
  workflow_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVE', 'REJECT', 'RESOLVE_TAKEOVER')),
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL,
  reason_code text,
  note text,
  status text NOT NULL CHECK (status IN ('PENDING', 'DELIVERED')),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  PRIMARY KEY (tenant_id, environment_id, event_id),
  FOREIGN KEY (tenant_id, environment_id, case_id)
    REFERENCES human_operations.refund_cases (tenant_id, environment_id, case_id)
);

CREATE INDEX case_audit_events_by_case
ON human_operations.case_audit_events (tenant_id, environment_id, case_id, occurred_at);

CREATE INDEX pending_decision_outbox_by_age
ON human_operations.decision_outbox (status, created_at)
WHERE status = 'PENDING';

ALTER TABLE human_operations.refund_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.refund_cases FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.case_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.case_audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.action_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.action_idempotency FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.decision_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.decision_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_environment_scope ON human_operations.refund_cases
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

CREATE POLICY tenant_environment_scope ON human_operations.case_audit_events
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

CREATE POLICY tenant_environment_scope ON human_operations.action_idempotency
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

CREATE POLICY tenant_environment_scope ON human_operations.decision_outbox
USING (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id())
WITH CHECK (tenant_id = security.current_tenant_id() AND environment_id = security.current_environment_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cso_human_operations_app') THEN
    GRANT USAGE ON SCHEMA security, human_operations TO cso_human_operations_app;
    GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO cso_human_operations_app;
    GRANT EXECUTE ON FUNCTION security.current_environment_id() TO cso_human_operations_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA human_operations TO cso_human_operations_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA human_operations
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cso_human_operations_app;
  END IF;
END
$$;
